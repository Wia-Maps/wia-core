import { useMemo, useState } from 'react';

import { DesktopPreview } from './DesktopPreview';
import { MobilePreview } from './MobilePreview';

export interface DemoLocation {
  id: string;
  name: string;
  category: string;
  eta: string;
  summary: string;
  routeLabel: string;
}

const demoLocations: DemoLocation[] = [
  {
    id: 'engineering-workshop',
    name: 'Engineering Central Workshop',
    category: 'Building',
    eta: '2 mins',
    summary: 'Closest route via North Access',
    routeLabel: 'Workshop route',
  },
  {
    id: 'engineering-building',
    name: 'Engineering Building',
    category: 'School',
    eta: '4 mins',
    summary: 'Fastest route via Main Spine',
    routeLabel: 'Faculty route',
  },
  {
    id: 'lecture-hall',
    name: 'Lecture Hall',
    category: 'Academic',
    eta: '3 mins',
    summary: 'Accessible route via Central Walk',
    routeLabel: 'Academic route',
  },
];

export function PreviewSection(): JSX.Element {
  const [selectedLocationId, setSelectedLocationId] = useState<string>(demoLocations[0].id);

  const selectedLocation = useMemo(
    () => demoLocations.find((location) => location.id === selectedLocationId) ?? demoLocations[0],
    [selectedLocationId],
  );

  return (
    <section className="border-y border-slate-200 bg-white px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
      <div className="mx-auto max-w-7xl">
        <div className="max-w-3xl">
          <span className="inline-flex w-fit items-center rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-sky-700">
            Live Preview
          </span>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            Experience WIA in Action
          </h2>
          <p className="mt-4 text-base leading-7 text-slate-600">
            A realistic product preview built around the same map-first shell your users interact with and the operator controls that keep routes, layers, and visibility in sync.
          </p>
        </div>

        <div className="mt-10 xl:hidden">
          <MobilePreview
            locations={demoLocations}
            selectedLocation={selectedLocation}
            onSelectLocation={setSelectedLocationId}
          />
        </div>

        <div className="mt-10 hidden xl:block">
          <DesktopPreview
            locations={demoLocations}
            selectedLocation={selectedLocation}
            onSelectLocation={setSelectedLocationId}
          />
        </div>
      </div>
    </section>
  );
}
