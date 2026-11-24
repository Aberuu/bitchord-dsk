import { Navigate, type RouteObject } from 'react-router';
import { notFound, pageElement, pages } from '@/pageRegistry';
import { AppShell, LAST_ROUTE_KEY } from '@/shell/AppShell';

function IndexRedirect() {
  let target = '/home';
  try {
    const saved = localStorage.getItem(LAST_ROUTE_KEY);
    if (saved && saved.startsWith('/') && !saved.startsWith('/invite') && saved !== '/') {
      target = saved;
    }
  } catch {
    // Ignore storage errors.
  }
  return <Navigate to={target} replace />;
}

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <IndexRedirect /> },
      ...pages.map((page) => ({ path: page.path, element: pageElement(page) })),
      { path: notFound.path, element: pageElement(notFound) },
    ],
  },
];
