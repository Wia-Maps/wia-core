import { AdminAuthProvider } from './context/AdminAuthContext';
import { ToastProvider } from './context/ToastContext';
import MapApp, { type MapAppProps } from './MapApp';

export default function MapShell(props: MapAppProps): JSX.Element {
  const normalizedPath = props.currentPath.replace(/\/+$/, '') || '/';
  const adminRoute = normalizedPath === '/admin' || normalizedPath.startsWith('/admin/');
  const content = <MapApp {...props} />;

  return (
    <ToastProvider>
      {adminRoute ? <AdminAuthProvider>{content}</AdminAuthProvider> : content}
    </ToastProvider>
  );
}
