use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

pub struct AudioHotplugWatcher {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl AudioHotplugWatcher {
    #[cfg(windows)]
    pub fn start(on_change: Arc<dyn Fn() + Send + Sync>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);

        let handle = thread::Builder::new()
            .name("bitchord-audio-hotplug".into())
            .spawn(move || run_windows_hotplug_loop(stop_thread, on_change))
            .ok();

        Self { stop, handle }
    }

    #[cfg(not(windows))]
    pub fn start(_on_change: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            handle: None,
        }
    }
}

impl Drop for AudioHotplugWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(windows)]
fn run_windows_hotplug_loop(stop: Arc<AtomicBool>, on_change: Arc<dyn Fn() + Send + Sync>) {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use windows::core::{implement, Result as WinResult, PCWSTR};
    use windows::Win32::Media::Audio::{
        eRender, EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient,
        IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

    #[implement(IMMNotificationClient)]
    struct Client {
        tx: mpsc::SyncSender<()>,
    }

    impl Client {
        fn notify(&self) {
            let _ = self.tx.try_send(());
        }
    }

    impl IMMNotificationClient_Impl for Client_Impl {
        fn OnDeviceStateChanged(&self, _pwstrdeviceid: &PCWSTR, _dwnewstate: DEVICE_STATE) -> WinResult<()> {
            self.notify();
            Ok(())
        }

        fn OnDeviceAdded(&self, _pwstrdeviceid: &PCWSTR) -> WinResult<()> {
            self.notify();
            Ok(())
        }

        fn OnDeviceRemoved(&self, _pwstrdeviceid: &PCWSTR) -> WinResult<()> {
            self.notify();
            Ok(())
        }

        fn OnDefaultDeviceChanged(
            &self,
            flow: EDataFlow,
            _role: ERole,
            _pwstrdefaultdeviceid: &PCWSTR,
        ) -> WinResult<()> {
            if flow == eRender {
                self.notify();
            }
            Ok(())
        }

        fn OnPropertyValueChanged(
            &self,
            _pwstrdeviceid: &PCWSTR,
            _key: &PROPERTYKEY,
        ) -> WinResult<()> {
            Ok(())
        }
    }

    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let should_uninit = hr.is_ok();

    let enumerator: WinResult<IMMDeviceEnumerator> =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) };
    let Ok(enumerator) = enumerator else {
        if should_uninit {
            unsafe { CoUninitialize() };
        }
        return;
    };

    let (tx, rx) = mpsc::sync_channel::<()>(1);
    let client: IMMNotificationClient = Client { tx }.into();
    if unsafe { enumerator.RegisterEndpointNotificationCallback(&client) }.is_err() {
        if should_uninit {
            unsafe { CoUninitialize() };
        }
        return;
    }

    // Coalesce rapid jack/USB enumeration bursts before signaling the frontend and engine.
    const DEBOUNCE: Duration = Duration::from_millis(160);
    let mut pending_since: Option<Instant> = None;

    while !stop.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(80)) {
            Ok(()) => {
                pending_since.get_or_insert_with(Instant::now);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if let Some(started) = pending_since {
            if started.elapsed() >= DEBOUNCE {
                pending_since = None;
                on_change();
            }
        }
    }

    let _ = unsafe { enumerator.UnregisterEndpointNotificationCallback(&client) };
    if should_uninit {
        unsafe { CoUninitialize() };
    }
}
