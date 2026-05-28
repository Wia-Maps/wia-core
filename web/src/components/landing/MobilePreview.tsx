import type { DemoLocation } from './PreviewSection';

interface MobilePreviewProps {
  locations: DemoLocation[];
  selectedLocation: DemoLocation;
  onSelectLocation: (locationId: string) => void;
}

const mobileMapPoint: Record<string, { x: string; y: string; label: string; labelOffset?: string }> = {
  'engineering-workshop': { x: '27%', y: '22%', label: 'Cafe Court', labelOffset: 'translate(-2%, -174%)' },
  'engineering-building': { x: '73%', y: '33%', label: 'Admin Block', labelOffset: 'translate(-34%, -182%)' },
  'lecture-hall': { x: '60%', y: '76%', label: 'Lecture Hall', labelOffset: 'translate(-42%, -182%)' },
};

const mobileFilters = ['Fast Food', 'Greenhouse', 'Residential'] as const;

export function MobilePreview({
  locations,
  selectedLocation,
  onSelectLocation,
}: MobilePreviewProps): JSX.Element {
  const activePoint = mobileMapPoint[selectedLocation.id] ?? mobileMapPoint['engineering-workshop'];

  return (
    <div className="flex justify-center">
      <div className="relative w-full max-w-[390px] px-4 py-5">
        <div className="relative rounded-[50px] bg-[linear-gradient(145deg,#111827_0%,#05070b_45%,#1f2937_100%)] p-[6px] shadow-[0_34px_100px_rgba(15,23,42,0.24)] ring-1 ring-black/70">
          <div className="rounded-[46px] bg-[linear-gradient(145deg,rgba(255,255,255,0.28)_0%,rgba(255,255,255,0.08)_18%,rgba(255,255,255,0.02)_52%,rgba(255,255,255,0.16)_100%)] p-[1.5px]">
            <div className="overflow-hidden rounded-[42px] border border-black/85 bg-slate-950 p-[4px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
              <div className="overflow-hidden rounded-[36px] bg-[#eef3f7]">
                <div className="relative aspect-[9/18.5] min-h-[680px] bg-[linear-gradient(180deg,#fdfdfb_0%,#eef3f7_100%)]">
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_55%_100%,rgba(15,23,42,0.16),transparent_26%),radial-gradient(circle_at_82%_18%,rgba(255,255,255,0.75),transparent_24%)]" />
                  <div className="absolute inset-x-0 top-0 z-10 h-[6.75rem] bg-white" />

                  <svg viewBox="0 0 320 700" className="absolute inset-0 h-full w-full" aria-hidden="true">
                    <path d="M262 0C250 24 250 44 258 78C266 114 288 144 320 176" fill="none" stroke="#f4ead0" strokeWidth="1.8" />
                    <path d="M200 36C164 64 146 96 138 140C128 190 100 226 58 270C28 300 8 332 0 372" fill="none" stroke="#f4ead0" strokeWidth="1.8" />
                    <path d="M108 162C162 150 214 148 278 164C294 168 306 174 320 184" fill="none" stroke="#f4ead0" strokeWidth="1.6" />
                    <path d="M92 464C144 442 198 438 256 452C282 458 302 468 320 480" fill="none" stroke="#f4ead0" strokeWidth="1.6" />
                    <path d="M136 540C176 528 216 526 262 536C284 540 304 548 320 558" fill="none" stroke="#f4ead0" strokeWidth="1.4" />

                    <g stroke="#4b5563" strokeWidth="2.1" fill="#fbfbfa">
                      <path d="M245 121 286 118 289 148 252 151Z" transform="rotate(-6 267 136)" />
                      <path d="M197 151 212 146 227 159 211 168Z" />
                      <path d="M175 186 185 176 195 187 184 201Z" />
                      <path d="M164 206 208 198 214 250 170 258Z" />
                      <path d="M223 204 263 199 268 255 226 259Z" />
                      <path d="M271 196 317 192 320 247 274 251Z" />
                      <path d="M146 286 190 281 198 347 152 351Z" />
                      <path d="M210 274 242 269 246 290 214 295Z" />
                      <path d="M96 321 108 311 118 327 104 338Z" />
                      <path d="M87 349 109 347 115 401 92 404Z" />
                      <path d="M34 211 58 208 63 286 40 289Z" />
                      <path d="M18 309 72 305 76 364 22 368Z" />
                      <path d="M11 381 54 378 59 425 15 429Z" />
                      <path d="M57 387 92 384 98 436 63 439Z" />
                      <path d="M71 473 104 466 110 500 78 507Z" />
                      <path d="M118 501 144 494 149 512 123 519Z" />
                      <path d="M145 521 168 519 206 541 182 551Z" />
                      <path d="M22 567 60 554 94 622 57 637Z" />
                      <path d="M86 599 123 590 133 628 96 637Z" />
                      <path d="M114 611 149 595 186 678 151 694 111 627Z" />
                      <path d="M248 589 274 578 289 635 264 647Z" />
                      <path d="M274 575 306 564 320 626 289 639Z" />
                    </g>

                    <rect x="74" y="478" width="40" height="98" fill="#dfe8d8" opacity="0.85" transform="rotate(-28 94 527)" />
                    <rect x="96" y="566" width="62" height="92" fill="#ebe4d3" opacity="0.78" transform="rotate(-30 127 612)" />
                  </svg>

                  <div className="absolute left-0 right-0 top-0 z-40 flex items-start justify-between bg-white px-8 pt-3 text-[15px] font-semibold text-slate-900">
                    <span className="tracking-[-0.02em]">9:41</span>
                    <div className="absolute left-1/2 top-2.5 h-[34px] w-[126px] -translate-x-1/2 rounded-full bg-black shadow-[inset_0_-1px_0_rgba(255,255,255,0.08)]">
                      <div className="absolute right-3.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[#0d1b30] shadow-[0_0_0_1px_rgba(56,189,248,0.18),inset_0_0_6px_rgba(0,0,0,0.45)]" />
                    </div>
                    <div className="flex items-center gap-2">
                      <svg viewBox="0 0 20 14" className="h-[14px] w-[16px] text-slate-900" aria-hidden="true">
                        <path d="M2 5.7A8.5 8.5 0 0 1 10 2a8.5 8.5 0 0 1 8 3.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                        <path d="M5 8.5A5.8 5.8 0 0 1 10 6a5.8 5.8 0 0 1 5 2.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                        <path d="M8.4 11.1A2.2 2.2 0 0 1 10 10.4a2.2 2.2 0 0 1 1.6.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                      </svg>
                      <div className="flex items-center gap-1">
                        <div className="h-[14px] w-[24px] rounded-[4px] border-[1.7px] border-slate-900 p-[1.5px]">
                          <div className="h-full w-[78%] rounded-[2px] bg-slate-900" />
                        </div>
                        <div className="h-[5px] w-[1.5px] rounded-full bg-slate-900" />
                      </div>
                    </div>
                  </div>

                  <div className="absolute right-3 top-0 z-30 rounded-b-xl border border-slate-300 bg-white px-3 py-0.5 text-[11px] font-semibold text-slate-500 shadow-sm">
                    100 m
                  </div>

                  <div className="absolute left-3 right-3 top-[4.35rem] z-20 flex items-center gap-3 rounded-full border border-slate-200 bg-white px-4 py-3 shadow-[0_16px_38px_rgba(15,23,42,0.12)] max-[360px]:left-2 max-[360px]:right-2 max-[360px]:top-[4.15rem] max-[360px]:px-3 max-[360px]:py-2.5">
                    <button
                      type="button"
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-cyan-700"
                      aria-label="Open mobile menu"
                    >
                      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                        <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                      </svg>
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium text-slate-400 max-[360px]:text-sm">Search campus</p>
                    </div>
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-cyan-700 max-[360px]:h-9 max-[360px]:w-9">
                      <svg viewBox="0 0 24 24" className="h-6 w-6 max-[360px]:h-5 max-[360px]:w-5" aria-hidden="true">
                        <path d="m21 21-4.3-4.3M10.7 18a7.3 7.3 0 1 0 0-14.6 7.3 7.3 0 0 0 0 14.6Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </div>

                  <div className="absolute left-3 right-3 top-[7.7rem] z-20 flex items-center gap-2 max-[360px]:left-2 max-[360px]:right-2 max-[360px]:top-[7.2rem]">
                    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto rounded-full bg-white/98 px-1 py-1 shadow-[0_10px_22px_rgba(15,23,42,0.08)] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                      {mobileFilters.map((filter, index) => {
                        const active =
                          (filter === 'Residential' && selectedLocation.id === 'lecture-hall')
                          || (filter === 'Greenhouse' && selectedLocation.id === 'engineering-building')
                          || (filter === 'Fast Food' && selectedLocation.id === 'engineering-workshop');
                        const nextLocation = locations[index] ?? selectedLocation;

                        return (
                          <button
                            key={filter}
                            type="button"
                            onClick={() => onSelectLocation(nextLocation.id)}
                            className={`inline-flex h-9 shrink-0 items-center rounded-full px-4 text-sm font-semibold transition max-[360px]:h-8 max-[360px]:px-3 max-[360px]:text-[13px] ${
                              active
                                ? 'border border-slate-900 bg-slate-900 text-white shadow-[0_10px_22px_rgba(15,23,42,0.12)]'
                                : 'border border-transparent bg-white text-slate-700'
                             }`}
                          >
                            {filter}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-[0_10px_22px_rgba(15,23,42,0.08)] max-[360px]:h-7 max-[360px]:w-7"
                      aria-label="Carousel next"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                        <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>

                  <div className="absolute left-3 top-[10.95rem] z-20 flex flex-col gap-[1px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_12px_24px_rgba(15,23,42,0.1)] max-[360px]:left-2 max-[360px]:top-[10.45rem]">
                    <button
                      type="button"
                      className="grid h-10 w-10 place-items-center bg-white text-slate-600"
                      aria-label="Zoom in"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                        <path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="grid h-10 w-10 place-items-center border-t border-slate-200 bg-white text-slate-600"
                      aria-label="Zoom out"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                        <path d="M6 12h12" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>

                  <div className="absolute left-[20%] top-[22%] z-10 h-4 w-4 rounded-full border-[4px] border-white bg-cyan-500 shadow-[0_0_0_10px_rgba(34,211,238,0.16)]" />
                  <div
                    className="absolute z-10 h-4 w-4 rounded-full border-4 border-white bg-slate-900 shadow-[0_0_0_10px_rgba(15,23,42,0.1)]"
                    style={{ left: activePoint.x, top: activePoint.y, transform: 'translate(-50%, -50%)' }}
                  />

                  <div className="absolute left-[18%] top-[16.5%] z-20 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm">
                    Main Gate
                  </div>
                  <div
                    className="absolute z-20 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm"
                    style={{ left: activePoint.x, top: activePoint.y, transform: activePoint.labelOffset ?? 'translate(-34%, -190%)' }}
                  >
                    {activePoint.label}
                  </div>

                  <button
                    type="button"
                    className="absolute bottom-14 right-3 z-20 grid h-11 w-11 place-items-center rounded-full border border-slate-200 bg-white text-cyan-600 shadow-[0_12px_24px_rgba(15,23,42,0.1)]"
                    aria-label="Locate me"
                  >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    className="absolute bottom-4 right-3 z-20 inline-flex h-11 items-center justify-center rounded-full border border-slate-200 bg-white px-5 text-sm font-semibold uppercase tracking-[0.04em] text-slate-600 shadow-[0_12px_24px_rgba(15,23,42,0.1)]"
                  >
                    Open Layers
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
