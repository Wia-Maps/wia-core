import type { CSSProperties } from 'react';

interface SplashSceneProps {
  introExiting: boolean;
}

interface DotSpec {
  x: number;
  y: number;
  delay: number;
  scale: number;
}

const NETWORK_DOTS: DotSpec[] = [
  { x: 14, y: 24, delay: 1.05, scale: 1 },
  { x: 24, y: 34, delay: 1.18, scale: 0.9 },
  { x: 35, y: 22, delay: 1.26, scale: 1.1 },
  { x: 46, y: 30, delay: 1.34, scale: 0.88 },
  { x: 56, y: 20, delay: 1.44, scale: 1 },
  { x: 66, y: 32, delay: 1.56, scale: 1.08 },
  { x: 77, y: 24, delay: 1.66, scale: 0.9 },
  { x: 86, y: 36, delay: 1.76, scale: 1 },
  { x: 18, y: 56, delay: 1.3, scale: 0.9 },
  { x: 29, y: 66, delay: 1.42, scale: 1.06 },
  { x: 40, y: 58, delay: 1.5, scale: 0.92 },
  { x: 52, y: 68, delay: 1.62, scale: 1.12 },
  { x: 63, y: 56, delay: 1.74, scale: 1 },
  { x: 74, y: 66, delay: 1.82, scale: 0.9 },
  { x: 84, y: 58, delay: 1.9, scale: 1.1 },
];

const dotStyle = (dot: DotSpec): CSSProperties => {
  return {
    '--x': `${dot.x}%`,
    '--y': `${dot.y}%`,
    '--d': `${dot.delay}s`,
    '--s': `${dot.scale}`,
  } as CSSProperties;
};

export const SplashScene: React.FC<SplashSceneProps> = ({ introExiting }) => {
  return (
    <section className={`intro-screen ${introExiting ? 'intro-screen-exit' : ''}`} aria-label="WIA splash screen">
      <div className="intro-gradient-layer" aria-hidden="true" />

      <div className="intro-shape intro-shape-a" aria-hidden="true" />
      <div className="intro-shape intro-shape-b" aria-hidden="true" />
      <div className="intro-shape intro-shape-c" aria-hidden="true" />

      <div className="intro-map-hint" aria-hidden="true">
        <svg className="intro-map-outline" viewBox="0 0 960 540">
          <path
            className="intro-map-line"
            d="M 70 140 L 270 90 L 430 128 L 620 86 L 830 142"
          />
          <path
            className="intro-map-line intro-map-line-soft"
            d="M 94 226 L 256 196 L 404 244 L 586 208 L 810 252"
          />
          <path
            className="intro-map-line"
            d="M 104 320 L 286 276 L 474 326 L 660 286 L 860 340"
          />
          <path
            className="intro-map-line intro-map-line-soft"
            d="M 130 416 L 322 378 L 504 426 L 702 388 L 884 436"
          />
          <path
            className="intro-map-link"
            d="M 170 90 L 168 438"
          />
          <path
            className="intro-map-link"
            d="M 332 84 L 328 444"
          />
          <path
            className="intro-map-link"
            d="M 502 82 L 500 446"
          />
          <path
            className="intro-map-link"
            d="M 674 82 L 676 446"
          />
          <path
            className="intro-map-link"
            d="M 836 84 L 842 446"
          />
        </svg>

        <div className="intro-network-grid">
          {NETWORK_DOTS.map((dot, index) => (
            <span
              key={`dot_${index}`}
              className="intro-network-dot"
              style={dotStyle(dot)}
            />
          ))}
        </div>
      </div>

      <div className="intro-center">
        <div className="intro-logo-glow" />

        <div className="intro-logo-wrap">
          <div className="intro-pin">
            <span className="intro-pin-inner" />
          </div>
        </div>

        <p className="intro-name">Wia</p>
        <p className="intro-tag">Smart navigation</p>
      </div>

      <div className="intro-loader" aria-hidden="true">
        <div className="intro-progress">
          <span className="intro-progress-fill" />
        </div>

        <div className="intro-dots">
          <span className="intro-dot" />
          <span className="intro-dot" />
          <span className="intro-dot" />
        </div>
      </div>
    </section>
  );
};

export default SplashScene;
