import { useEffect, useState } from 'react';
import { LandingPage } from './components/LandingPage';
import MapShell from './MapShell';

const MAP_PATH = '/map';

const normalizePath = (value: string): string => {
  if (!value) {
    return '/';
  }

  const normalized = value.replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : '/';
};

/**
 * Main app shell with intro transition and map-first home.
 */
function App(): JSX.Element {
  const [currentPath, setCurrentPath] = useState(() => {
    if (typeof window === 'undefined') {
      return '/';
    }

    return normalizePath(window.location.pathname);
  });
  const landingPageVisible = normalizePath(currentPath) === '/';

  const navigateToPath = (path: string): void => {
    if (typeof window === 'undefined') {
      return;
    }

    const normalizedTargetPath = normalizePath(path);

    if (normalizePath(window.location.pathname) !== normalizedTargetPath) {
      window.history.pushState({}, '', normalizedTargetPath);
    }

    setCurrentPath(normalizedTargetPath);
  };

  const navigateToMapPage = (): void => {
    navigateToPath(MAP_PATH);
  };

  useEffect((): (() => void) => {
    const handlePopState = (): void => {
      setCurrentPath(normalizePath(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);

    return (): void => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  return (
    <div className="app-stage">
      <div className="wia-ambient-glow" />

      <div className="app-content-shell app-content-visible">
        <div className="ride-app-shell">
          {landingPageVisible ? (
            <LandingPage onOpenMap={navigateToMapPage} />
          ) : (
            <MapShell currentPath={currentPath} onNavigate={navigateToPath} />
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
