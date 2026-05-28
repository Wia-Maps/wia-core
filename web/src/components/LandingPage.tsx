import { useMemo, useState, type FormEvent, type MouseEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { PreviewSection } from './landing/PreviewSection';

interface LandingPageProps {
  onOpenMap?: () => void;
}

type NavTarget = 'features' | 'use-cases' | 'how-it-works' | 'request-demo';

interface FeatureCard {
  icon: 'route' | 'navigation' | 'layers';
  eyebrow: string;
  title: string;
  description: string;
  bullets: string[];
}

interface UseCaseCard {
  icon: 'campus' | 'estate' | 'hospital' | 'corporate';
  title: string;
  description: string;
  stat: string;
}

interface NavigationIssue {
  icon: 'warning' | 'shield';
  title: string;
  description: string;
}

interface FormState {
  name: string;
  workEmail: string;
  organization: string;
  environmentType: string;
  message: string;
}

const navigationItems: Array<{ id: NavTarget; label: string }> = [
  { id: 'features', label: 'Features' },
  { id: 'use-cases', label: 'Use Cases' },
  { id: 'how-it-works', label: 'How It Works' },
];

const featureCards: FeatureCard[] = [
  {
    icon: 'route',
    eyebrow: 'Route Workflows',
    title: 'Create, manage, and adjust internal routes with control',
    description:
      'Give operations teams one place to author WalkTo-ready paths, manage closures, and keep route behavior aligned with how people should move through the environment.',
    bullets: ['Author managed routes and closures', 'Control entries, buildings, and destination access', 'Publish route changes in real time'],
  },
  {
    icon: 'navigation',
    eyebrow: 'Smart Navigation',
    title: 'Guide users through complex private environments',
    description:
      'WIA combines graph search and optimized pathfinding to return reliable routes that match private roads, walkways, entrances, and campus-specific movement rules.',
    bullets: ['Hybrid A* + Dijkstra routing', 'Search across roads, paths, and places', 'Built for real visitor and resident journeys'],
  },
  {
    icon: 'layers',
    eyebrow: 'Operational Layers',
    title: 'Run live overlays for power, fellowship, and map visibility',
    description:
      'Use your organization’s map data to shape a branded navigation layer that reflects how your environment actually works.',
    bullets: ['Live power control views', 'Fellowship schedules and room badges', 'Custom map layers and visibility rules'],
  },
];

const useCases: UseCaseCard[] = [
  {
    icon: 'campus',
    title: 'Universities',
    description:
      'Help students, staff, and first-time visitors find lecture halls, departments, hostels, and service points while surfacing fellowship schedules and room badges where they matter.',
    stat: 'Large, multi-building campuses',
  },
  {
    icon: 'estate',
    title: 'Estates',
    description:
      'Give residents and guests clear directions across gated communities while retaining control over visible roads and access-sensitive paths.',
    stat: 'Private roads and controlled access',
  },
  {
    icon: 'hospital',
    title: 'Hospitals',
    description:
      'Reduce arrival stress by guiding patients and visitors to clinics, labs, wards, and parking zones with fewer wrong turns.',
    stat: 'High-pressure visitor journeys',
  },
  {
    icon: 'corporate',
    title: 'Corporate Campuses',
    description:
      'Support employees, vendors, and guests moving between offices, gates, parking, and shared facilities while operators manage WalkTo routes and live power control across large corporate grounds.',
    stat: 'Multi-site internal wayfinding',
  },
];

const navigationIssues: NavigationIssue[] = [
  {
    icon: 'warning',
    title: 'People still get lost in familiar spaces',
    description:
      'Campuses, estates, hospitals, and company grounds grow quickly. Internal roads, footpaths, route rules, and destination names shift faster than public maps can keep up.',
  },
  {
    icon: 'shield',
    title: 'Public maps do not reflect internal reality',
    description:
      'Organizations need a system that respects private routes, hidden access paths, temporary visibility changes, fellowship overlays, and operational updates without waiting on external map providers.',
  },
];

const environmentOptions = ['University campus', 'Residential estate', 'Hospital', 'Corporate campus', 'Other'];

const initialFormState: FormState = {
  name: '',
  workEmail: '',
  organization: '',
  environmentType: environmentOptions[0],
  message: '',
};

const sectionViewport = { once: true, amount: 0.2 };

function renderIcon(
  icon:
    | FeatureCard['icon']
    | UseCaseCard['icon']
    | NavigationIssue['icon']
    | 'real-time'
    | 'private-control'
    | 'multi-mode',
): JSX.Element {
  const iconClassName = 'h-5 w-5';

  switch (icon) {
    case 'route':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M7 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10-12a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
          <path d="M9 16c4 0 2-8 8-8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m14 6 3-2 3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'navigation':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m13.6 4.2 5.7 5.7-8.8 8.8-5.8 1 1-5.8 8.9-8.7Z" strokeLinejoin="round" />
          <path d="m12 9 3 3" strokeLinecap="round" />
        </svg>
      );
    case 'layers':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m12 4 8 4-8 4-8-4 8-4Z" strokeLinejoin="round" />
          <path d="m4 12 8 4 8-4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m4 16 8 4 8-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'campus':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 20h16" strokeLinecap="round" />
          <path d="M6 20V9l6-3 6 3v11" strokeLinejoin="round" />
          <path d="M10 12h.01M14 12h.01M10 16h.01M14 16h.01" strokeLinecap="round" />
        </svg>
      );
    case 'estate':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m4 11 8-6 8 6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M6 10v10h12V10" strokeLinejoin="round" />
          <path d="M10 20v-5h4v5" strokeLinejoin="round" />
        </svg>
      );
    case 'hospital':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M8 4v16M16 4v16M4 8h16M4 16h16" strokeLinecap="round" />
          <path d="M12 8v8M8 12h8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'corporate':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 20h16" strokeLinecap="round" />
          <path d="M6 20V6h12v14" strokeLinejoin="round" />
          <path d="M9 9h.01M12 9h.01M15 9h.01M9 13h.01M12 13h.01M15 13h.01" strokeLinecap="round" />
        </svg>
      );
    case 'warning':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 4 21 20H3L12 4Z" strokeLinejoin="round" />
          <path d="M12 9v4" strokeLinecap="round" />
          <path d="M12 17h.01" strokeLinecap="round" />
        </svg>
      );
    case 'shield':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3 5 6v5c0 4.4 2.8 8.4 7 10 4.2-1.6 7-5.6 7-10V6l-7-3Z" strokeLinejoin="round" />
          <path d="m9.5 12 1.7 1.7 3.3-3.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'real-time':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="7" />
          <path d="M12 8v4l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'private-control':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M7 11V8a5 5 0 0 1 10 0v3" strokeLinecap="round" />
          <rect x="5" y="11" width="14" height="9" rx="2" />
        </svg>
      );
    case 'multi-mode':
      return (
        <svg viewBox="0 0 24 24" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 8h14M5 12h10M5 16h14" strokeLinecap="round" />
          <circle cx="17" cy="12" r="2" />
        </svg>
      );
  }
}

function scrollToSection(sectionId: NavTarget): void {
  const target = document.getElementById(sectionId);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function handleAnchorClick(
  event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
  sectionId: NavTarget,
  onAfter?: () => void,
): void {
  event.preventDefault();
  onAfter?.();
  window.setTimeout(() => scrollToSection(sectionId), 0);
}

function BrandMark(): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_16px_32px_rgba(15,23,42,0.08)]">
        <img src="/logo.webp" alt="WIA logo" className="h-full w-full object-cover" />
      </div>
      <div className="flex flex-col">
        <span className="text-base font-semibold tracking-tight text-slate-950">WIA</span>
        <span className="text-xs font-medium text-slate-500">Know Where. Know Now</span>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <span className="inline-flex w-fit items-center rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-sky-700 shadow-sm">
      {children}
    </span>
  );
}

function HeroScreenshotStack(): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="relative mx-auto w-full max-w-[720px] lg:mx-0"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(14,165,233,0.18),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(148,163,184,0.16),transparent_32%)] blur-3xl" />

      <div className="relative min-h-[360px] pt-4 sm:min-h-[420px] sm:pt-5 lg:min-h-[440px] xl:min-h-[450px] xl:pt-0">
        <motion.div animate={{ y: [0, -6, 0] }} transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}>
          <div className="relative ml-auto w-full max-w-[700px] overflow-hidden rounded-[34px] border border-white/80 bg-white/88 p-3 shadow-[0_24px_64px_rgba(15,23,42,0.12)] backdrop-blur">
            <div className="overflow-hidden rounded-[28px] border border-slate-200/80 bg-white">
              <img
                src="/Macbook-Air-localhost.webp"
                alt="WIA desktop workspace showing campus layers, directory, and navigation controls"
                className="h-full w-full object-cover object-center"
              />
            </div>
          </div>
        </motion.div>

        <motion.div
          animate={{ y: [0, 8, 0], rotate: [-1, 0.6, -1] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute bottom-[1.15rem] left-3 z-10 w-[31%] min-w-[132px] max-w-[172px] overflow-hidden rounded-[30px] border border-white/85 bg-white/92 p-2 shadow-[0_18px_42px_rgba(15,23,42,0.1)] backdrop-blur sm:bottom-[0.2rem] sm:left-5 sm:min-w-[150px] sm:max-w-[188px] lg:bottom-[-1.35rem] lg:left-8 lg:w-[30%] lg:min-w-[162px] lg:max-w-[198px] xl:bottom-[-1.75rem] xl:left-8 xl:w-[29%] xl:max-w-[206px]"
        >
          <div className="overflow-hidden rounded-[24px] border border-slate-200/80 bg-white">
            <img
              src="/iPhone-14-Plus-localhost.webp"
              alt="WIA mobile navigation preview showing map search and on-campus routing"
              className="h-full w-full object-cover object-center"
            />
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

function DemoRequestForm(): JSX.Element {
  const [formState, setFormState] = useState<FormState>(initialFormState);

  const hiddenMessage = useMemo(
    () =>
      [
        `Environment Type: ${formState.environmentType}`,
        formState.message ? `Notes: ${formState.message}` : 'Notes: No extra notes provided.',
      ].join('\n'),
    [formState.environmentType, formState.message],
  );

  const updateField = (field: keyof FormState) =>
    (event: FormEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>): void => {
      const value = event.currentTarget.value;
      setFormState((current) => ({ ...current, [field]: value }));
    };

  return (
    <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_30px_80px_rgba(15,23,42,0.08)] sm:p-8">
      <div className="max-w-xl">
        <SectionLabel>Request Demo</SectionLabel>
        <h3 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
          Take control of your navigation system
        </h3>
        <p className="mt-4 text-base leading-7 text-slate-600">
          Tell us about your environment and we’ll follow up with a guided walkthrough of how WIA fits your roads,
          buildings, and operational rules.
        </p>
      </div>

      <form
        action="https://api.web3forms.com/submit"
        method="POST"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-8 grid gap-4 sm:grid-cols-2"
      >
        <input type="hidden" name="access_key" value="6bfcfc8d-6b52-4d7a-be3f-9688d3f4616c" />
        <input type="hidden" name="subject" value="WIA Demo Request" />
        <input type="hidden" name="from_name" value="WIA Landing Page" />
        <input type="hidden" name="message" value={hiddenMessage} />
        <input type="hidden" name="redirect" value="https://web3forms.com/success" />

        <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
          Full name
          <input
            type="text"
            name="name"
            required
            value={formState.name}
            onInput={updateField('name')}
            placeholder="Jane Doe"
            className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-950 outline-none transition focus:border-cyan-400 focus:bg-white focus:ring-4 focus:ring-cyan-100"
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
          Work email
          <input
            type="email"
            name="email"
            required
            value={formState.workEmail}
            onInput={updateField('workEmail')}
            placeholder="team@organization.com"
            className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-950 outline-none transition focus:border-cyan-400 focus:bg-white focus:ring-4 focus:ring-cyan-100"
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
          Organization
          <input
            type="text"
            name="organization"
            required
            value={formState.organization}
            onInput={updateField('organization')}
            placeholder="North Campus Estate"
            className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-950 outline-none transition focus:border-cyan-400 focus:bg-white focus:ring-4 focus:ring-cyan-100"
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
          Environment type
          <select
            name="environment_type"
            value={formState.environmentType}
            onChange={updateField('environmentType')}
            className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-950 outline-none transition focus:border-cyan-400 focus:bg-white focus:ring-4 focus:ring-cyan-100"
          >
            {environmentOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="sm:col-span-2 flex flex-col gap-2 text-sm font-medium text-slate-700">
          What should we know about your environment?
          <textarea
            name="notes"
            rows={5}
            value={formState.message}
            onInput={updateField('message')}
            placeholder="Tell us about your roads, buildings, visitor traffic, or internal routing needs."
            className="rounded-3xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-cyan-400 focus:bg-white focus:ring-4 focus:ring-cyan-100"
          />
        </label>

        <div className="sm:col-span-2 flex flex-col gap-4 pt-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-md text-sm leading-6 text-slate-500">
            We use this information only to prepare a relevant demo for your organization.
          </p>
          <button
            type="submit"
            className="inline-flex h-12 items-center justify-center rounded-2xl bg-cyan-600 px-6 text-sm font-semibold text-white shadow-[0_14px_34px_rgba(8,145,178,0.18)] transition hover:-translate-y-0.5 hover:bg-cyan-700 focus:outline-none focus:ring-4 focus:ring-cyan-100"
          >
            Request Demo
          </button>
        </div>
      </form>
    </div>
  );
}

export function LandingPage({ onOpenMap: _onOpenMap }: LandingPageProps): JSX.Element {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="landing-scroll-shell h-full overflow-x-hidden overflow-y-auto bg-[#f4f7fb] text-slate-900">
      <div className="mx-auto flex min-h-full w-full max-w-[1600px] flex-col">
        <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-[#f4f7fb]/92 backdrop-blur-xl">
          <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
            <BrandMark />

            <nav className="hidden items-center gap-8 lg:flex">
              {navigationItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={(event) => handleAnchorClick(event, item.id)}
                  className="text-sm font-medium text-slate-600 transition hover:text-slate-950"
                >
                  {item.label}
                </button>
              ))}
            </nav>

            <div className="hidden items-center gap-3 lg:flex">
              <button
                type="button"
                onClick={(event) => handleAnchorClick(event, 'request-demo')}
                className="inline-flex h-11 items-center justify-center rounded-2xl bg-cyan-600 px-5 text-sm font-semibold text-white shadow-[0_14px_34px_rgba(8,145,178,0.18)] transition hover:-translate-y-0.5 hover:bg-cyan-700 focus:outline-none focus:ring-4 focus:ring-cyan-100"
              >
                Request Demo
              </button>
            </div>

            <button
              type="button"
              onClick={() => setMobileMenuOpen((open) => !open)}
              className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-transparent text-slate-700 transition hover:bg-slate-100/70 hover:text-slate-950 lg:hidden"
              aria-expanded={mobileMenuOpen}
              aria-label="Toggle navigation menu"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                {mobileMenuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 6L18 18M6 18L18 6" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 7H20M4 12H20M4 17H20" />
                )}
              </svg>
            </button>
          </div>

          <AnimatePresence initial={false}>
            {mobileMenuOpen ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.26, ease: 'easeInOut' }}
                className="overflow-hidden border-t border-slate-200 bg-white lg:hidden"
              >
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-4 sm:px-6"
                >
                  {navigationItems.map((item, index) => (
                    <motion.button
                      key={item.id}
                      type="button"
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.18, ease: 'easeOut', delay: index * 0.04 }}
                      onClick={(event) => handleAnchorClick(event, item.id, () => setMobileMenuOpen(false))}
                      className="flex h-11 items-center rounded-2xl px-4 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950"
                    >
                      {item.label}
                    </motion.button>
                  ))}
                  <motion.button
                    type="button"
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.18, ease: 'easeOut', delay: 0.12 }}
                    onClick={(event) => handleAnchorClick(event, 'request-demo', () => setMobileMenuOpen(false))}
                    className="mt-2 inline-flex h-11 items-center justify-center rounded-2xl bg-cyan-600 px-4 text-sm font-semibold text-white transition hover:bg-cyan-700"
                  >
                    Request Demo
                  </motion.button>
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </header>

        <main className="flex-1">
          <section className="px-4 pb-16 pt-12 sm:px-6 lg:px-8 lg:pb-24 lg:pt-16">
            <div className="mx-auto grid max-w-7xl items-center gap-12 xl:grid-cols-[minmax(0,0.92fr)_minmax(540px,1.08fr)] xl:gap-16">
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, ease: 'easeOut' }}
                className="max-w-2xl xl:max-w-none"
              >
                <motion.h1
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6, ease: 'easeOut', delay: 0.05 }}
                  className="text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl lg:max-w-[10ch] lg:text-[4.5rem] lg:leading-[0.96] xl:max-w-none xl:text-[5rem]"
                >
                  Navigation Systems for Campuses and Estates
                </motion.h1>
                <motion.p
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.55, ease: 'easeOut', delay: 0.14 }}
                  className="mt-5 max-w-[38rem] text-[1.05rem] leading-8 text-slate-600"
                >
                  Give people a smarter way to move through private environments while your team stays in control of routes, layers, visibility, and operational updates.
                </motion.p>

                <motion.div
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, ease: 'easeOut', delay: 0.22 }}
                  className="mt-8 flex flex-col gap-3 sm:flex-row"
                >
                  <button
                    type="button"
                    onClick={(event) => handleAnchorClick(event, 'request-demo')}
                    className="inline-flex h-12 items-center justify-center rounded-2xl bg-cyan-600 px-6 text-sm font-semibold text-white shadow-[0_14px_34px_rgba(8,145,178,0.18)] transition hover:-translate-y-0.5 hover:bg-cyan-700 focus:outline-none focus:ring-4 focus:ring-cyan-100"
                  >
                    Request Demo
                  </button>
                  <button
                    type="button"
                    onClick={(event) => handleAnchorClick(event, 'how-it-works')}
                    className="inline-flex h-12 items-center justify-center rounded-2xl border border-slate-200 bg-white px-6 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus:ring-4 focus:ring-slate-200"
                  >
                    See How It Works
                  </button>
                </motion.div>

                <div className="mt-10 grid gap-3 md:grid-cols-3">
                  {[
                    { value: 'Real-time', label: 'Live route and visibility updates', icon: 'real-time' as const },
                    { value: 'Private control', label: 'Manage roads, access, and layers', icon: 'private-control' as const },
                    { value: 'Multi-mode', label: 'Routing, fellowship, and power context', icon: 'multi-mode' as const },
                  ].map((item, index) => (
                    <motion.div
                      key={item.value}
                      initial={{ opacity: 0, y: 18 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.45, ease: 'easeOut', delay: 0.28 + index * 0.08 }}
                      className="rounded-[24px] border border-slate-200 bg-white px-4 py-3 shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-[0_18px_44px_rgba(15,23,42,0.08)]"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-700">
                          {renderIcon(item.icon)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-[14px] font-semibold leading-5 text-slate-950">{item.value}</p>
                          <p className="mt-1 text-[12px] leading-5 text-slate-500">{item.label}</p>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>

              <HeroScreenshotStack />
            </div>
          </section>

          <section className="border-y border-slate-200 bg-white px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
            <div className="mx-auto grid max-w-7xl gap-12 xl:grid-cols-[0.85fr_1.15fr] xl:items-center">
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={sectionViewport}
                transition={{ duration: 0.5, ease: 'easeOut' }}
                className="max-w-xl"
              >
                <SectionLabel>Problem / Solution</SectionLabel>
                <h2 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                  Navigation breaks down when your environment is not built for public maps
                </h2>
                <p className="mt-4 text-base leading-7 text-slate-600">
                  WIA gives organizations a private navigation layer for roads, walkways, landmarks, fellowship venues,
                  power-aware operations, and live map visibility updates that matter inside controlled environments.
                </p>
              </motion.div>

              <div className="grid gap-4 lg:grid-cols-2">
                {navigationIssues.map((issue, index) => (
                  <motion.div
                    key={issue.title}
                    initial={{ opacity: 0, y: 18 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={sectionViewport}
                    transition={{ duration: 0.45, ease: 'easeOut', delay: index * 0.08 }}
                    className="rounded-[28px] border border-slate-200 bg-slate-50 p-6 shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-[0_18px_44px_rgba(15,23,42,0.08)]"
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-sky-700 shadow-sm">
                      {renderIcon(issue.icon)}
                    </div>
                    <h3 className="text-xl font-semibold tracking-tight text-slate-950">{issue.title}</h3>
                    <p className="mt-3 text-sm leading-7 text-slate-600">{issue.description}</p>
                  </motion.div>
                ))}
                <motion.div
                  initial={{ opacity: 0, y: 18 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={sectionViewport}
                  transition={{ duration: 0.5, ease: 'easeOut', delay: 0.08 }}
                  className="rounded-[28px] border border-sky-200 bg-gradient-to-br from-sky-50 to-cyan-50 p-6 shadow-[0_24px_56px_rgba(15,23,42,0.08)] md:col-span-2"
                >
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sky-700">Why WIA</p>
                  <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-700">
                    Instead of sending users to incomplete public directions, WIA lets you define what exists, what is
                    visible, how routes behave, and which live overlays should appear from the moment people arrive.
                  </p>
                </motion.div>
              </div>
            </div>
          </section>

          <section id="features" className="px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
            <div className="mx-auto max-w-7xl">
              <div className="max-w-2xl">
                <SectionLabel>Core Features</SectionLabel>
                <h2 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                  Built for operators and the people moving through their spaces
                </h2>
              </div>

              <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                {featureCards.map((card, index) => (
                  <motion.div
                    key={card.title}
                    initial={{ opacity: 0, y: 18 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={sectionViewport}
                    transition={{ duration: 0.45, ease: 'easeOut', delay: index * 0.08 }}
                    className="group flex h-full flex-col rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-[0_22px_50px_rgba(15,23,42,0.08)]"
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-sky-700 transition duration-300 group-hover:bg-sky-100">
                      {renderIcon(card.icon)}
                    </div>
                    <p className="mt-5 text-sm font-semibold uppercase tracking-[0.14em] text-sky-700">{card.eyebrow}</p>
                    <h3 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">{card.title}</h3>
                    <p className="mt-4 text-sm leading-7 text-slate-600">{card.description}</p>
                    <div className="mt-6 space-y-3">
                      {card.bullets.map((bullet) => (
                        <div key={bullet} className="flex items-start gap-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
                          <span className="mt-1 h-2.5 w-2.5 rounded-full bg-cyan-500" />
                          <span>{bullet}</span>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>

          <section id="how-it-works" className="border-y border-slate-200 bg-white px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
            <div className="mx-auto max-w-7xl">
              <div className="max-w-2xl">
                <SectionLabel>How It Works</SectionLabel>
                <h2 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                  Launch a private navigation experience in three steps
                </h2>
              </div>

              <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                {[
                  {
                    step: '01',
                    title: 'Model your environment and map layers',
                    description:
                      'Import or configure the base map for your campus, estate, hospital, or company facility, then shape the layers people should actually navigate.',
                  },
                  {
                    step: '02',
                    title: 'Configure routes, places, and live controls',
                    description:
                      'Admins define WalkTo-ready routes, landmarks, building entries, fellowship info, power states, and visibility rules for the places people need to reach.',
                  },
                  {
                    step: '03',
                    title: 'Deliver live navigation and visibility updates',
                    description:
                      'Students, residents, staff, and visitors search destinations and receive optimized navigation shaped by private roads, overlays, and operational changes.',
                  },
                ].map((item, index) => (
                  <motion.div
                    key={item.step}
                    initial={{ opacity: 0, y: 18 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={sectionViewport}
                    transition={{ duration: 0.45, ease: 'easeOut', delay: index * 0.08 }}
                    className="rounded-[28px] border border-slate-200 bg-slate-50 p-6 shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-[0_18px_44px_rgba(15,23,42,0.08)]"
                  >
                    <span className={`inline-flex h-12 w-12 items-center justify-center rounded-2xl text-sm font-semibold text-white ${
                      index === 0 ? 'bg-cyan-600' : index === 1 ? 'bg-sky-600' : 'bg-slate-900'
                    }`}>
                      {item.step}
                    </span>
                    <h3 className="mt-6 text-2xl font-semibold tracking-tight text-slate-950">{item.title}</h3>
                    <p className="mt-4 text-sm leading-7 text-slate-600">{item.description}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>

          <section id="use-cases" className="px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
            <div className="mx-auto max-w-7xl">
              <div className="max-w-2xl">
                <SectionLabel>Use Cases</SectionLabel>
                <h2 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                  A better fit for environments that depend on local knowledge
                </h2>
              </div>

              <div className="mt-10 grid gap-5 md:grid-cols-2">
                {useCases.map((useCase, index) => (
                  <motion.div
                    key={useCase.title}
                    initial={{ opacity: 0, y: 18 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={sectionViewport}
                    transition={{ duration: 0.45, ease: 'easeOut', delay: index * 0.07 }}
                    className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-[0_18px_44px_rgba(15,23,42,0.08)]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-50 text-sky-700">
                          {renderIcon(useCase.icon)}
                        </div>
                        <h3 className="text-2xl font-semibold tracking-tight text-slate-950">{useCase.title}</h3>
                      </div>
                      <span className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-sky-700">
                        {useCase.stat}
                      </span>
                    </div>
                    <p className="mt-4 text-sm leading-7 text-slate-600">{useCase.description}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>

          <section className="border-y border-slate-200 bg-gradient-to-br from-sky-900 via-cyan-800 to-slate-900 px-4 py-16 text-white sm:px-6 lg:px-8 lg:py-24">
            <div className="mx-auto grid max-w-7xl gap-10 xl:grid-cols-[0.9fr_1.1fr] xl:items-center">
              <div className="max-w-xl">
                <span className="inline-flex w-fit items-center rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-cyan-100 shadow-sm">
                  Why Not Google Maps
                </span>
                <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Public maps are not designed to operate private infrastructure
                </h2>
                <p className="mt-4 text-base leading-7 text-slate-200">
                  Google Maps can help people reach your gate. WIA helps them move through everything after that.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {[
                  {
                    title: 'No control over private routes',
                    detail: 'Public maps cannot reflect sensitive roads, service lanes, WalkTo-managed paths, or access-specific routes on your terms.',
                  },
                  {
                    title: 'Weak internal operations context',
                    detail: 'Building entries, fellowship venues, layer visibility, and temporary operational states often go missing or stale in public data.',
                  },
                  {
                    title: 'WIA stays under your control',
                    detail: 'Your organization decides what users see, when power or fellowship information appears, and how routes should behave in real time.',
                  },
                ].map((item, index) => (
                  <motion.div
                    key={item.title}
                    initial={{ opacity: 0, y: 18 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={sectionViewport}
                    transition={{ duration: 0.45, ease: 'easeOut', delay: index * 0.08 }}
                    className="rounded-[28px] border border-white/10 bg-white/10 p-5 backdrop-blur transition duration-300 hover:-translate-y-1 hover:bg-white/12"
                  >
                    <h3 className="text-lg font-semibold tracking-tight text-white">{item.title}</h3>
                    <p className="mt-3 text-sm leading-7 text-slate-200">{item.detail}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>

          <PreviewSection />

          <section id="request-demo" className="px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
            <div className="mx-auto max-w-7xl">
              <DemoRequestForm />
            </div>
          </section>
        </main>

        <footer className="border-t border-slate-200 bg-white px-4 py-10 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-7xl flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-md">
              <BrandMark />
              <p className="mt-4 text-sm leading-7 text-slate-600">
                WIA helps organizations deliver reliable internal navigation across campuses, estates, hospitals, and
                corporate facilities.
              </p>
            </div>

            <div className="grid gap-8 sm:grid-cols-3">
              <div>
                <p className="text-sm font-semibold text-slate-950">Links</p>
                <div className="mt-4 flex flex-col gap-3 text-sm text-slate-600">
                  {navigationItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={(event) => handleAnchorClick(event, item.id)}
                      className="text-left transition hover:text-slate-950"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-slate-950">Contact</p>
                <div className="mt-4 flex flex-col gap-3 text-sm text-slate-600">
                  <a href="mailto:hello@wia.dev" className="transition hover:text-slate-950">
                    hello@wia.dev
                  </a>
                  <a
                    href="https://www.linkedin.com/company/wia-navigation/"
                    target="_blank"
                    rel="noreferrer"
                    className="transition hover:text-slate-950"
                  >
                    LinkedIn
                  </a>
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-slate-950">Resources</p>
                <div className="mt-4 flex flex-col gap-3 text-sm text-slate-600">
                  <a href="https://github.com/your-org/wia" target="_blank" rel="noreferrer" className="transition hover:text-slate-950">
                    GitHub
                  </a>
                  <a href="https://docs.wia.dev" target="_blank" rel="noreferrer" className="transition hover:text-slate-950">
                    Docs
                  </a>
                </div>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
