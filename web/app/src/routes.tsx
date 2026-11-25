import { useEffect } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import { notFound, pageElement, pages } from '@/pageRegistry';
import { AppShell, LAST_ROUTE_KEY } from '@/shell/AppShell';

function IndexRedirect() {
  useEffect(() => {
    try {
      localStorage.removeItem(LAST_ROUTE_KEY);
    } catch {
      // Ignore storage errors.
    }
  }, []);
  return <Navigate to="/home" replace />;
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
