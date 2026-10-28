"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { BrandMark } from "./brand-mark";

export const fonts = {
  heading: '"Patrick Hand", cursive',
  body: '"Caveat", cursive',
  mono: '"Architects Daughter", cursive',
};

/* ===================== HERO ===================== */
export function HeroSection() {
  return (
    <section id="hero" className="relative min-h-screen flex flex-col items-center justify-center px-6 overflow-hidden pt-14">
      <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
        <motion.div
          className="absolute top-1/4 left-1/2 w-[600px] h-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-sage-soft/60 blur-[120px]"
          animate={{ scale: [0.9, 1, 0.9] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
      <motion.div
        className="relative z-10 text-center max-w-2xl"
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
      >
        <span className="inline-block mb-4 px-4 py-1.5 rounded-full bg-white border border-border-strong shadow-card text-[14px] font-mono text-ink">
          Picture-book landing · Mockup Studio
        </span>
        <h1
          className="mb-6 text-5xl md:text-7xl font-heading text-ink tracking-tight leading-[1.05]"
          style={{ fontFamily: fonts.heading }}
        >
          Turn Art into Income
        </h1>
        <p className="mb-10 text-lg md:text-xl font-body text-ink-muted leading-relaxed"
          style={{ fontFamily: fonts.body }}
        >
          Upload your artwork, place it on real products, let AI write the
          listing — and publish with one click.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 items-center justify-center">
          <Button size="lg" href="/auth/signup">
            Start Free →
          </Button>
          <Button variant="outline" size="lg" href="#how">
            See how it works
          </Button>
        </div>
        <motion.div
          className="mt-12 relative w-full max-w-md mx-auto"
          animate={{ y: [0, -10, 0] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        >
          <SketchDemo />
        </motion.div>
      </motion.div>
    </section>
  );
}

/* ===================== PROBLEM / SOLUTION ===================== */
export function ProblemSolutionSection() {
  return (
    <section id="problem" className="py-20 px-6 border-y border-border-subtle bg-white">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-16">
          <span className="text-xs font-mono tracking-widest uppercase text-sage-deep">The story so far</span>
          <h2 className="mt-4 text-3xl font-heading text-ink" style={{ fontFamily: fonts.heading }}>
            Selling art is harder than making it
          </h2>
        </div>
        <div className="grid md:grid-cols-2 gap-8 items-center">
          <div className="p-8 rounded-2xl border border-border-strong bg-sage-soft relative overflow-hidden">
            <div className="absolute inset-0 opacity-10 pointer-events-none">
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 10 Q 60 110 110 10" stroke="currentColor" strokeWidth={2} fill="none" />
              </svg>
            </div>
            <h3 className="text-xl font-heading text-ink mb-3" style={{ fontFamily: fonts.heading }}>Today</h3>
            <ul className="space-y-3 font-body text-ink-muted leading-relaxed" style={{ fontFamily: fonts.body }}>
              <li className="flex items-start gap-2">
                <span className="flex w-3 h-3 items-center justify-center text-ink">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 2 l8 8 M10 2 L2 10"/></svg>
                </span>
                Design tools don't speak print-on-demand
              </li>
              <li className="flex items-start gap-2">
                <span className="flex w-3 h-3 items-center justify-center text-ink">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 2 l8 8 M10 2 L2 10"/></svg>
                </span>
                Mockups cost a studio you don't have
              </li>
              <li className="flex items-start gap-2">
                <span className="flex w-3 h-3 items-center justify-center text-ink">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 2 l8 8 M10 2 L2 10"/></svg>
                </span>
                Writing listings eats your evenings
              </li>
            </ul>
          </div>
          <div className="p-8 rounded-2xl border border-border-strong bg-surface relative overflow-hidden">
            <div className="absolute inset-0 opacity-10 pointer-events-none">
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 110 Q 60 10 110 110" stroke="forest-deep" strokeWidth={2} fill="none" />
              </svg>
            </div>
            <h3 className="text-xl font-heading text-forest-deep mb-3" style={{ fontFamily: fonts.heading }}>
              With Mockup Studio
            </h3>
            <ul className="space-y-3 font-body text-ink leading-relaxed" style={{ fontFamily: fonts.body }}>
              <li className="flex items-start gap-2">
                <span className="flex w-3 h-3 items-center justify-center text-forest">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 6 5 10 11 2"/></svg>
                </span>
                Upload art, place it on real print areas
              </li>
              <li className="flex items-start gap-2">
                <span className="flex w-3 h-3 items-center justify-center text-forest">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 6 5 10 11 2"/></svg>
                </span>
                Save renders straight to your listings
              </li>
              <li className="flex items-start gap-2">
                <span className="flex w-3 h-3 items-center justify-center text-forest">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 6 5 10 11 2"/></svg>
                </span>
                AI writes titles, tags, descriptions
              </li>
              <li className="flex items-start gap-2">
                <span className="flex w-3 h-3 items-center justify-center text-forest">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 6 5 10 11 2"/></svg>
                </span>
                One click publishes to Printify
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ===================== HOW IT WORKS (4-step) ===================== */
export function HowItWorksSection() {
  const steps = [
    { num: "01", title: "Upload art", body: "Drop your design onto a real Printify print area." },
    { num: "02", title: "Place on products", body: "Drag, scale and rotate your artwork on each mockup." },
    { num: "03", title: "AI writes listings", body: "Titles, tags and descriptions grounded in Etsy research." },
    { num: "04", title: "One-click publish", body: "Send mockups to Printify and publish your product." },
  ];
  return (
    <section id="how" className="py-20 px-6 bg-[#fdfbf6]">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-16">
          <span className="text-xs font-mono tracking-widest uppercase text-sage-deep">The picture book</span>
          <h2 className="mt-4 text-3xl font-heading text-ink" style={{ fontFamily: fonts.heading }}>
            Four steps to your first product
          </h2>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {steps.map((s) => (
            <StepCard key={s.num} step={s} />
          ))}
        </div>
      </div>
    </section>
  );
}

function StepCard({ step }: { step: { num: string; title: string; body: string } }) {
  return (
    <motion.div
      whileInView={{ y: [20, 0], opacity: [0, 1] }}
      viewport={{ once: true }}
      className="p-8 rounded-2xl border border-border-strong bg-surface relative overflow-hidden"
    >
      <div className="absolute top-6 right-6 text-3xl font-mono text-forest-soft opacity-40">
        {step.num}
      </div>
      <h3 className="text-xl font-heading text-ink mb-3" style={{ fontFamily: fonts.heading }}>
        {step.title}
      </h3>
      <p className="font-body text-ink-muted leading-relaxed" style={{ fontFamily: fonts.body }}>
        {step.body}
      </p>
      <div className="mt-6 h-1 w-6 rounded-full bg-border-strong" />
    </motion.div>
  );
}

/* ===================== SOCIAL PROOF ===================== */
export function SocialProofSection() {
  return (
    <section id="proof" className="py-20 px-6 border-y border-border-subtle bg-white">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-12">
          <span className="text-xs font-mono tracking-widest uppercase text-sage-deep">What sellers say</span>
          <h2 className="mt-4 text-3xl font-heading text-ink" style={{ fontFamily: fonts.heading }}>
            Hand-drawn words from real shops
          </h2>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <TestimonialCard key={i} n={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

function TestimonialCard({ n }: { n: number }) {
  return (
    <motion.div
      whileInView={{ y: [20, 0], opacity: [0, 1] }}
      viewport={{ once: true }}
      className="p-8 rounded-2xl border border-border-strong bg-surface relative"
    >
      <div className="absolute top-4 left-4 w-10 h-10 rounded-full bg-sage-soft flex items-center justify-center">
        <span className="font-heading text-forest-deep text-sm" style={{ fontFamily: fonts.heading }}>
          {n}
        </span>
      </div>
      <p className="mt-6 font-body text-ink leading-relaxed italic" style={{ fontFamily: fonts.body }}>
        "It turned my sketches into a real shop in an afternoon."
      </p>
      <div className="mt-6 flex items-start gap-3">
        <div className="flex flex-col">
          <span className="font-mono font-medium text-ink">Alex Rivera</span>
          <span className="text-xs text-ink-muted font-body">Printify seller</span>
        </div>
      </div>
    </motion.div>
  );
}

/* ===================== FEATURES GRID (8) ===================== */
export function FeaturesGridSection() {
  const features = [
    { t: "Real Printify areas", b: "Place art on actual print areas, not guesses." },
    { t: "AI SEO listings", b: "Titles, tags and descriptions written for you." },
    { t: "Save & render", b: "Compose mockups locally and reuse them everywhere." },
    { t: "Background removal", b: "Local cutout, no key, no upload, no limit." },
    { t: "Ink pairs", b: "Black + white ink designs become one listing." },
    { t: "Variant control", b: "Pick colours, sizes and prices per variant." },
    { t: "One-click publish", b: "Send mockups to Printify and go live." },
    { t: "Etsy research", b: "Ground your copy in live active listings." },
  ];
  return (
    <section id="features" className="py-20 px-6 bg-[#fdfbf6]">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-16">
          <span className="text-xs font-mono tracking-widest uppercase text-sage-deep">What it does</span>
          <h2 className="mt-4 text-3xl font-heading text-ink" style={{ fontFamily: fonts.heading }}>
            Eight illustrated capabilities
          </h2>
        </div>
        <div className="grid md:grid-cols-4 gap-6">
          {features.map((f, i) => (
            <FeatureCard key={i} n={i + 1} feature={f} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ n, feature }: { n: number; feature: { t: string; b: string } }) {
  return (
    <motion.div
      whileInView={{ y: [20, 0], opacity: [0, 1] }}
      viewport={{ once: true }}
      className="p-6 rounded-2xl border border-border-strong bg-surface"
    >
      <div className="w-10 h-10 rounded-xl bg-sage-soft flex items-center justify-center mb-4">
        <span className="font-mono text-forest-deep" style={{ fontFamily: fonts.heading }}>
          {n}
        </span>
      </div>
      <h4 className="font-heading text-ink" style={{ fontFamily: fonts.heading }}>
        {feature.t}
      </h4>
      <p className="mt-2 font-body text-sm text-ink-muted leading-relaxed" style={{ fontFamily: fonts.body }}>
        {feature.b}
      </p>
    </motion.div>
  );
}

/* ===================== PRICING ===================== */
export function PricingSection() {
  const plans = [
    { name: "Free", price: "$0", desc: "Start designing and rendering.", highlight: false },
    { name: "Pro", price: "$12/mo", desc: "AI listings + one-click publish.", highlight: true },
    { name: "Enterprise", price: "Contact", desc: "Volume batching and team seats.", highlight: false },
  ];
  return (
    <section id="pricing" className="py-20 px-6 border-y border-border-subtle bg-white">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-16">
          <span className="text-xs font-mono tracking-widest uppercase text-sage-deep">Pick a chapter</span>
          <h2 className="mt-4 text-3xl font-heading text-ink" style={{ fontFamily: fonts.heading }}>
            Simple, honest pricing
          </h2>
        </div>
        <div className="grid md:grid-cols-3 gap-6 items-center">
          {plans.map((p) => (
            <PricingCard key={p.name} plan={p} />
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingCard({ plan }: { plan: { name: string; price: string; desc: string; highlight: boolean } }) {
  return (
    <motion.div
      whileInView={{ y: [20, 0], opacity: [0, 1] }}
      viewport={{ once: true }}
      className={cn(
        "p-8 rounded-2xl border border-border-strong relative",
        plan.highlight ? "bg-surface border-forest shadow-pop" : "bg-white",
      )}
    >
      {plan.highlight && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-forest text-white text-[11px] font-mono uppercase tracking-widest">
          Most popular
        </span>
      )}
      <h4 className="font-heading text-ink text-lg" style={{ fontFamily: fonts.heading }}>
        {plan.name}
      </h4>
      <div className="mt-2 font-mono text-2xl text-ink">{plan.price}</div>
      <p className="mt-4 font-body text-sm text-ink-muted leading-relaxed" style={{ fontFamily: fonts.body }}>
        {plan.desc}
      </p>
      <Button variant={plan.highlight ? "default" : "outline"} className="w-full mt-6" href="/auth/signup">
        {plan.name === "Free" ? "Start free" : "Choose"}
      </Button>
    </motion.div>
  );
}

/* ===================== FAQ ===================== */
export function FAQSection() {
  const faqs = [
    { q: "Do I need a Printify account?", a: "Yes — to publish. You can design and render without one." },
    { q: "Is my art stored on your servers?", a: "No. Everything stays in your browser's IndexedDB." },
    { q: "Can I skip onboarding later?", a: "Yes — every step is skippable and resumable." },
    { q: "Does AI cost extra?", a: "Only if you use a provider key; a free fallback copy is included." },
  ];
  return (
    <section id="faq" className="py-20 px-6 bg-[#fdfbf6]">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-12">
          <span className="text-xs font-mono tracking-widest uppercase text-sage-deep">Questions</span>
          <h2 className="mt-4 text-3xl font-heading text-ink" style={{ fontFamily: fonts.heading }}>
            Frequently asked
          </h2>
        </div>
        <div className="space-y-4">
          {faqs.map((f, i) => (
            <FAQItem key={i} q={f.q} a={f.a} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="rounded-xl border border-border-strong bg-surface overflow-hidden"
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-6 py-4 text-left outline-none transition bg-transparent"
      >
        <span className="font-heading text-ink" style={{ fontFamily: fonts.heading }}>
          {q}
        </span>
        <span className={cn("w-5 h-5 transition-transform", open ? "rotate-180" : "")} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 8 8 4 8 8"/></svg>
        </span>
      </button>
      <AnimatePresence mode="wait">
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-6 pb-4"
          >
            <p className="font-body text-sm text-ink-muted leading-relaxed" style={{ fontFamily: fonts.body }}>
              {a}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ===================== CTA ===================== */
export function CTASection() {
  return (
    <section id="cta" className="py-24 px-6">
      <div className="max-w-2xl mx-auto">
        <div className="p-10 rounded-2xl border border-border-strong bg-white shadow-card text-center">
          <h2 className="text-3xl font-heading text-ink mb-4" style={{ fontFamily: fonts.heading }}>
            Ready to turn art into income?
          </h2>
          <p className="font-body text-ink-muted mb-8 leading-relaxed" style={{ fontFamily: fonts.body }}>
            Start free. No credit card. Your art stays on your device.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button size="lg" href="/auth/signup">
              Start Free →
            </Button>
            <Button variant="outline" size="lg" href="/printify-studio">
              Browse the studio
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ===================== LANDING PAGE ===================== */
function Header() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border-subtle bg-[#fdfbf6]/85 backdrop-blur-sm">
      <div className="mx-auto max-w-5xl px-6 h-14 flex items-center justify-between">
        <BrandMark href="/" size={26} />
        <div className="flex items-center gap-2">
          <a href="/auth/signin" className="text-sm font-medium text-ink hover:text-forest transition-colors no-underline px-3 py-2">
            Sign in
          </a>
          <a href="/auth/signup" className="rounded-full bg-forest text-white text-sm font-medium px-4 py-2 hover:bg-forest-deep transition-colors no-underline shadow-subtle">
            Start free
          </a>
        </div>
      </div>
    </header>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen bg-[#fdfbf6] text-ink overflow-x-hidden" style={{ scrollBehavior: "smooth" }}>
      <Header />
      <HeroSection />
      <ProblemSolutionSection />
      <HowItWorksSection />
      <SocialProofSection />
      <FeaturesGridSection />
      <PricingSection />
      <FAQSection />
      <CTASection />
    </div>
  );
}

export default LandingPage;

/* ===================== SHARED BUTTON ===================== */
type ButtonSize = "sm" | "default" | "lg";
type ButtonVariant = "default" | "outline";

type ButtonProps = {
  className?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
};

function Button({
  className,
  size = "default",
  variant = "default",
  href,
  onClick,
  children,
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 cursor-pointer select-none whitespace-nowrap";
  const variants: Record<ButtonVariant, string> = {
    default: "bg-forest text-white hover:bg-forest-deep shadow-subtle",
    outline: "border border-border-strong bg-surface text-ink hover:bg-surface-muted",
  };
  const sizes: Record<ButtonSize, string> = {
    sm: "h-8 px-3 text-[13px]",
    default: "h-9 px-4",
    lg: "h-10 px-5",
  };
  const classes = cn(base, variants[variant], sizes[size], className);
  if (href) {
    return (
      <a
        href={href}
        className={cn(classes, "cursor-pointer")}
        onClick={onClick}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      className={classes}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SketchDemo() {
  return (
    <svg
      width="320"
      height="240"
      viewBox="0 0 320 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="mx-auto"
    >
      <defs>
        <filter id="rough" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="3" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="4" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <path
        d="M40 110 Q 160 20 280 110 T 40 110"
        stroke="currentColor" strokeWidth={4} fill="none"
        strokeLinecap="round" strokeLinejoin="round"
        filter="url(#rough)"
      >
        <animate
          attributeName="d"
          dur="3s"
          repeatCount="indefinite"
          values="M40 110 Q 160 20 280 110 T 40 110;M40 110 Q 160 170 280 110 T 40 110;M40 110 Q 160 20 280 110 T 40 110"
        />
      </path>
      <circle cx="160" cy="110" r="26" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round">
        <animate attributeName="r" values="26;34;26" dur="3s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
