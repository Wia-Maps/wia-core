import type { DemoLocation } from './PreviewSection';

interface DesktopPreviewProps {
  locations: DemoLocation[];
  selectedLocation: DemoLocation;
  onSelectLocation: (locationId: string) => void;
}

const categoryFilters = ['All', 'Building', 'Fast Food', 'Greenhouse'] as const;

const directoryLocations: Array<{ id: string; category: string; name: string }> = [
  { id: 'engineering-workshop', category: 'Building', name: 'Engineering Central Workshop' },
  { id: 'engineering-building', category: 'School', name: 'Engineering Building' },
  { id: 'joked-complex', category: 'Site', name: 'JOKED Complex' },
];

export function DesktopPreview({
  locations,
  selectedLocation,
  onSelectLocation,
}: DesktopPreviewProps): JSX.Element {
  return (
    <div className="rounded-[34px] bg-[#303237] p-4 shadow-[0_30px_90px_rgba(15,23,42,0.14)]">
      <div className="mx-auto max-w-[1460px] rounded-[28px] border border-[#5b5d62] bg-black p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]">
        <div className="flex justify-center pb-3">
          <div className="h-3 w-3 rounded-full bg-[#121826] shadow-[0_0_0_2px_rgba(255,255,255,0.05)]" />
        </div>

        <div className="overflow-hidden rounded-[8px] bg-white">
          <div className="flex items-center gap-6 bg-[#2f2f31] px-[72px] py-3 text-white/80">
            <div className="flex items-center gap-8">
              <button type="button" className="text-white/80">
                <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
                  <path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" className="text-white/80">
                <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
                  <path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" className="text-white/80">
                <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
                  <path d="M5 19V7.6c0-.9.7-1.6 1.6-1.6h4.6c.4 0 .8.2 1.1.5l1.2 1.2c.3.3.7.5 1.1.5h2.8c.9 0 1.6.7 1.6 1.6V19M12 6v13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            <div className="flex min-w-0 flex-1 items-center rounded-xl bg-[#575759] px-4 py-2.5 text-[15px] font-medium text-white/95">
              <span className="mr-4 text-[18px]">Aa</span>
              <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
                <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                  <path d="M7 10V8a5 5 0 0 1 10 0v2M8.2 10h7.6c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H8.2c-.7 0-1.2-.5-1.2-1.2v-6.6c0-.7.5-1.2 1.2-1.2Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="truncate">localhost</span>
              </div>
              <svg viewBox="0 0 24 24" className="ml-4 h-5 w-5" aria-hidden="true">
                <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            <div className="flex items-center gap-10">
              <button type="button" className="text-white/80">
                <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
                  <path d="M12 16V4m0 0 4 4m-4-4-4 4M5 14v3.6c0 .8.6 1.4 1.4 1.4h11.2c.8 0 1.4-.6 1.4-1.4V14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" className="text-white/80">
                <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                </svg>
              </button>
              <button type="button" className="text-white/80">
                <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
                  <rect x="4" y="7" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M9 3h11a1 1 0 0 1 1 1v11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

          <div className="relative min-h-[620px] overflow-hidden bg-[#f8f8f6]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_100%,rgba(31,41,55,0.16),transparent_26%),radial-gradient(circle_at_50%_58%,rgba(255,255,255,0.72),transparent_28%)]" />

            <svg viewBox="0 0 1500 820" className="absolute inset-0 h-full w-full" aria-hidden="true">
              <path d="M45 42C104 76 120 124 138 190C156 260 196 314 240 364C288 418 316 494 314 576C312 654 272 716 230 792" fill="none" stroke="#f4ead0" strokeWidth="2.4" />
              <path d="M495 30C544 70 558 118 562 196C566 262 608 332 692 374C776 416 834 458 864 540C886 602 934 666 1018 788" fill="none" stroke="#f5ebd2" strokeWidth="2.2" />
              <path d="M694 108C790 88 864 74 960 92C1070 114 1172 166 1304 180C1384 188 1434 170 1474 154" fill="none" stroke="#f5ebd2" strokeWidth="2" />
              <path d="M812 266C906 238 968 224 1066 236C1182 250 1280 304 1448 312" fill="none" stroke="#f5ebd2" strokeWidth="2" />
              <path d="M892 474C994 450 1082 438 1186 460C1298 484 1390 560 1492 570" fill="none" stroke="#f5ebd2" strokeWidth="2" />

              <g stroke="#465264" strokeWidth="2.8" fill="#fbfbfa">
                <rect x="178" y="144" width="40" height="40" />
                <rect x="186" y="428" width="22" height="18" />
                <rect x="214" y="436" width="30" height="10" />
                <rect x="170" y="466" width="34" height="12" />
                <rect x="166" y="498" width="40" height="16" />
                <rect x="164" y="540" width="32" height="18" />
                <rect x="200" y="542" width="28" height="18" />
                <rect x="162" y="574" width="26" height="16" />
                <rect x="194" y="574" width="34" height="18" />

                <rect x="528" y="222" width="18" height="18" transform="rotate(-42 537 231)" />
                <rect x="518" y="268" width="20" height="22" transform="rotate(-34 528 279)" />
                <rect x="548" y="250" width="16" height="34" transform="rotate(-34 556 267)" />
                <rect x="566" y="190" width="36" height="80" transform="rotate(-11 584 230)" />
                <rect x="626" y="172" width="58" height="112" transform="rotate(-14 655 228)" />
                <rect x="612" y="304" width="22" height="44" transform="rotate(-6 623 326)" />
                <rect x="664" y="306" width="48" height="70" transform="rotate(-4 688 341)" />
                <rect x="722" y="300" width="48" height="70" transform="rotate(-4 746 335)" />
                <rect x="658" y="390" width="40" height="42" transform="rotate(-5 678 411)" />
                <rect x="716" y="388" width="54" height="44" transform="rotate(-5 743 410)" />
                <rect x="760" y="188" width="80" height="18" transform="rotate(-8 800 197)" />
                <rect x="846" y="168" width="94" height="26" transform="rotate(-8 893 181)" />
                <rect x="896" y="204" width="10" height="48" transform="rotate(90 901 228)" />
                <rect x="918" y="204" width="10" height="48" transform="rotate(90 923 228)" />
                <rect x="942" y="204" width="10" height="48" transform="rotate(90 947 228)" />
                <rect x="814" y="250" width="52" height="60" transform="rotate(-2 840 280)" />
                <rect x="878" y="254" width="50" height="60" transform="rotate(-2 903 284)" />
                <rect x="944" y="262" width="44" height="58" transform="rotate(-2 966 291)" />
                <rect x="1036" y="254" width="42" height="48" transform="rotate(-35 1057 278)" />
                <rect x="1106" y="224" width="40" height="66" transform="rotate(-30 1126 257)" />
                <rect x="1256" y="62" width="86" height="40" transform="rotate(-8 1299 82)" />
                <rect x="836" y="432" width="42" height="34" transform="rotate(-8 857 449)" />
                <rect x="914" y="404" width="28" height="14" transform="rotate(-16 928 411)" />
                <rect x="954" y="444" width="30" height="120" transform="rotate(-28 969 504)" />
                <rect x="856" y="510" width="34" height="28" transform="rotate(-12 873 524)" />
                <rect x="812" y="552" width="54" height="58" transform="rotate(-32 839 581)" />
                <rect x="906" y="560" width="22" height="18" transform="rotate(-12 917 569)" />
                <rect x="950" y="538" width="74" height="24" transform="rotate(-42 987 550)" />
                <rect x="986" y="612" width="74" height="22" transform="rotate(-32 1023 623)" />
                <rect x="760" y="664" width="36" height="22" transform="rotate(-36 778 675)" />
                <rect x="520" y="658" width="30" height="74" transform="rotate(-36 535 695)" />
                <rect x="-8" y="700" width="28" height="116" transform="rotate(10 6 758)" />
              </g>

              <rect x="708" y="504" width="38" height="102" fill="#dbe8d7" opacity="0.85" transform="rotate(-20 727 555)" />
              <rect x="630" y="544" width="54" height="116" fill="#efe9d8" opacity="0.78" transform="rotate(-20 657 602)" />
              <rect x="768" y="580" width="82" height="126" fill="#eee8d7" opacity="0.78" transform="rotate(-32 809 643)" />
            </svg>

            <div className="absolute left-0 top-0 h-full w-[84px] rounded-r-[28px] border-r border-slate-200/70 bg-white/92 shadow-[0_22px_54px_rgba(15,23,42,0.07)] backdrop-blur">
              <div className="flex h-full flex-col items-center gap-10 pt-7">
                <button type="button" className="grid h-11 w-11 place-items-center rounded-2xl text-slate-500">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                    <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                  </svg>
                </button>
                {['saved', 'recent', 'alerts', 'school'].map((item, index) => (
                  <div key={item} className="grid h-11 w-11 place-items-center rounded-2xl text-slate-500">
                    {index === 0 && (
                      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                        <path d="M7 5.5h10a1 1 0 0 1 1 1V19l-6-3-6 3V6.5a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    {index === 1 && (
                      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                        <path d="M12 7v5l3 2.5M20 12a8 8 0 1 1-3-6.3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    {index === 2 && (
                      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                        <path d="M12 19a2.6 2.6 0 0 0 2.6-2.6H9.4A2.6 2.6 0 0 0 12 19Zm4.6-5.2V11a4.6 4.6 0 1 0-9.2 0v2.8L6 15v1.4h12V15l-1.4-1.2Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    {index === 3 && (
                      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                        <path d="m4 11 8-4 8 4-8 4-8-4Zm3 2.3v3.4L12 19l5-2.3v-3.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="absolute left-[108px] right-[382px] top-[18px] z-20 flex items-center gap-4">
              <div className="flex min-w-0 flex-1 items-center rounded-full border border-white/90 bg-white/95 px-5 py-3.5 shadow-[0_14px_32px_rgba(15,23,42,0.1)]">
                <span className="mr-4 grid h-11 w-11 place-items-center rounded-full bg-white text-cyan-700">
                  <svg viewBox="0 0 24 24" className="h-5.5 w-5.5" aria-hidden="true">
                    <path d="m21 21-4.3-4.3M10.7 18a7.3 7.3 0 1 0 0-14.6 7.3 7.3 0 0 0 0 14.6Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="text-[18px] font-medium text-slate-400">Search campus</span>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                {categoryFilters.map((item, index) => {
                  const active = item === 'All' || (item === 'Building' && selectedLocation.category === 'Building');

                  return (
                    <button
                      key={item}
                      type="button"
                      onClick={() => {
                        const match = locations.find((location) => item === 'Building' && location.category === 'Building') ?? locations[0];
                        if (match) {
                          onSelectLocation(match.id);
                        }
                      }}
                      className={`rounded-full border px-5 py-3 text-[15px] font-semibold shadow-[0_8px_18px_rgba(15,23,42,0.07)] ${
                        active && index < 2
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 bg-white text-slate-700'
                      }`}
                    >
                      {item}
                    </button>
                  );
                })}
                <button type="button" className="grid h-11 w-11 place-items-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-[0_8px_18px_rgba(15,23,42,0.07)]">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                    <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>

            <aside className="absolute right-[22px] top-[108px] z-20 w-[430px] overflow-hidden rounded-[28px] border border-white/85 bg-white/95 shadow-[0_20px_54px_rgba(15,23,42,0.1)] backdrop-blur">
              <div className="flex items-start justify-between gap-4 px-7 py-6">
                <h3 className="font-['Outfit'] text-[32px] font-semibold leading-none text-slate-900">Campus layers</h3>
                <div className="flex items-center gap-3">
                  <div className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 p-1">
                    <button type="button" className="rounded-full bg-slate-900 px-5 py-2 text-[14px] font-semibold uppercase tracking-[0.12em] text-white">
                      Flat
                    </button>
                    <button type="button" className="rounded-full px-5 py-2 text-[14px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                      2.5D
                    </button>
                  </div>
                  <button type="button" className="grid h-11 w-11 place-items-center rounded-full border border-slate-200 bg-white text-slate-500">
                    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                      <path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="border-t border-slate-100 px-7 py-6">
                <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-5">
                  <p className="text-[13px] font-semibold uppercase tracking-[0.16em] text-slate-500">Fellowships</p>
                  <p className="mt-1 text-[15px] leading-6 text-slate-500">Show fellowship schedules and room badges on host venues</p>
                  <button type="button" className="mt-4 rounded-full border border-slate-200 bg-white px-5 py-2.5 text-[15px] font-semibold text-slate-700">
                    Overlay off
                  </button>
                </div>

                <div className="mt-6 flex items-end justify-between gap-4">
                  <h4 className="font-['Outfit'] text-[30px] font-semibold leading-none text-slate-900">Directory</h4>
                  <span className="text-[14px] font-semibold uppercase tracking-[0.14em] text-slate-500">115 shown</span>
                </div>

                <div className="mt-4 space-y-4">
                  {directoryLocations.map((location) => {
                    const active = location.id === selectedLocation.id;
                    const isInteractive = locations.some((item) => item.id === location.id);

                    return (
                      <button
                        key={location.id}
                        type="button"
                        onClick={() => {
                          if (isInteractive) {
                            onSelectLocation(location.id);
                          }
                        }}
                        className={`w-full rounded-[24px] border px-5 py-5 text-left transition ${
                          active
                            ? 'border-sky-200 bg-white shadow-[0_18px_38px_rgba(15,23,42,0.08)]'
                            : 'border-slate-200 bg-white'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            {location.category}
                          </span>
                          <span className="text-[14px] font-semibold uppercase tracking-[0.14em] text-sky-600">Open</span>
                        </div>
                        <h5 className="mt-4 font-['Outfit'] text-[22px] font-semibold leading-tight text-slate-900">{location.name}</h5>
                      </button>
                    );
                  })}
                </div>
              </div>
            </aside>

            <div className="absolute bottom-[10px] right-[18px] z-20 flex items-center gap-4 text-slate-500">
              <div className="rounded-full border border-slate-300 bg-white/90 px-4 py-1 text-[13px] font-semibold shadow-sm">
                100 m
              </div>
              <div className="text-[12px] font-medium">&copy; OpenStreetMap contributors &copy; CARTO</div>
              <div className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-[15px] font-semibold text-slate-900 shadow-sm">
                i
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
