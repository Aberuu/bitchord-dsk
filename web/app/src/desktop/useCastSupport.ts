import { useCast } from './castStore';

export function useCastSupport() {
  return useCast((s) => s.support);
}

export function useCastSession() {
  return useCast((s) => s.session);
}
