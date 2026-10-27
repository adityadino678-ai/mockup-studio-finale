"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { fonts } from "./landing-page";

const STORAGE_KEY = "mockup-studio:onboarding";

const STEPS = [
  { id: "welcome", title: "Welcome", body: "Let's set up your studio." },
  { id: "printify", title: "Connect Printify", body: "Link your Printify shop so you can publish." },
  { id: "etsy", title: "Connect Etsy", body: "Ground your listings in live Etsy research (optional)." },
  { id: "ai", title: "AI Provider", body: "Pick an AI provider for SEO listings (free fallback included)." },
  { id: "upload", title: "Upload First Design", body: "Drop your artwork onto a print area." },
  { id: "product", title: "Create First Product", body: "Pick colours, sizes and place your art." },
  { id: "listing", title: "AI Writes Listing", body: "Generate a title, tags and description." },
  { id: "publish", title: "Publish", body: "Send your mockups to Printify and go live." },
  { id: "celebrate", title: "Celebration", body: "You're ready. Open the studio and keep creating." },
] as const;

type StepId = (typeof STEPS)[number]["id"];

function loadProgress(): { done: StepId[]; skipped: boolean } {
  if (typeof window === "undefined") return { done: [], skipped: false };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { done: [], skipped: false };
    const parsed = JSON.parse(raw);
    return {
      done: Array.isArray(parsed.done) ? (parsed.done as StepId[]) : [],
      skipped: Boolean(parsed.skipped),
    };
  } catch {
    return { done: [], skipped: false };
  }
}

function saveProgress(done: StepId[], skipped: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ done, skipped }));
}

export function OnboardingWizard() {
  const [progress, setProgress] = React.useState<{ done: StepId[]; skipped: boolean }>(() =>
    loadProgress(),
  );
  const [stepIndex, setStepIndex] = React.useState(0);

  const isDone = (id: StepId) => progress.done.includes(id);
  const completeStep = (id: StepId) => {
    setProgress((p) => {
      const next = p.done.includes(id) ? p.done : [...p.done, id];
      saveProgress(next, p.skipped);
      return { ...p, done: next };
    });
  };

  const current = STEPS[stepIndex];
  const last = stepIndex === STEPS.length - 1;

  const isComplete = progress.done.length === STEPS.length || progress.skipped;

  if (isComplete) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#fdfbf6] px-6 text-center">
        <div className="max-w-md">
          <div className="w-16 h-16 rounded-full bg-forest flex items-center justify-center mx-auto mb-6">
            <span className="text-white font-mono text-2xl">✓</span>
          </div>
          <h2 className="text-2xl font-heading text-ink mb-4" style={{ fontFamily: fonts.heading }}>
            Studio ready
          </h2>
          <p className="font-body text-ink-muted mb-8" style={{ fontFamily: fonts.body }}>
            Your onboarding is complete. Jump into the studio and start creating.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => (window.location.href = "/printify-studio")}
              className="px-5 py-2 rounded-md bg-forest text-white text-sm font-medium hover:bg-forest-deep"
            >
              Open Studio
            </button>
            <button
              onClick={() => {
                setProgress({ done: [], skipped: false });
                saveProgress([], false);
                setStepIndex(0);
              }}
              className="px-5 py-2 rounded-md border border-border-strong bg-surface text-ink text-sm font-medium hover:bg-surface-muted"
            >
              Restart
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fdfbf6] text-ink px-6">
      <div className="max-w-3xl mx-auto py-12">
        {/* Progress */}
        <div className="mb-8">
          <p className="text-xs font-mono tracking-widest uppercase text-sage-deep mb-2">
            Onboarding {stepIndex + 1} of {STEPS.length}
          </p>
          <div className="w-full bg-border-strong rounded-full h-2 overflow-hidden">
            <motion.div
              className="h-full bg-forest"
              style={{ width: `${((stepIndex) / Math.max(STEPS.length - 1, 1)) * 100}%` }}
            />
          </div>
        </div>

        {/* Card */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          className="rounded-2xl border border-border-strong bg-surface shadow-card p-10"
        >
          <div className="flex items-center justify-between mb-8">
            <span className="w-8 h-8 rounded-full bg-sage-soft flex items-center justify-center font-mono text-forest-deep">
              {stepIndex + 1}
            </span>
            {progress.skipped && (
              <span className="text-xs font-mono text-ink-muted">Skipped · resumable</span>
            )}
          </div>
          <h3 className="text-2xl font-heading text-ink mb-3" style={{ fontFamily: fonts.heading }}>
            {current.title}
          </h3>
          <p className="font-body text-ink mb-8 leading-relaxed" style={{ fontFamily: fonts.body }}>
            {current.body}
          </p>

          <div className="flex items-center justify-between">
            <div className="flex gap-3">
              {stepIndex > 0 && (
                <button
                  onClick={() => setStepIndex((i) => i - 1)}
                  className="px-4 py-2 rounded-md border border-border-strong bg-surface text-ink text-sm font-medium hover:bg-surface-muted"
                >
                  Back
                </button>
              )}
              {!isDone(current.id) && (
                <button
                  onClick={() => completeStep(current.id)}
                  className="px-5 py-2 rounded-md bg-forest text-white text-sm font-medium hover:bg-forest-deep"
                >
                  {last ? "Finish" : "Next"}
                </button>
              )}
              {isDone(current.id) && (
                <button
                  onClick={() => setStepIndex((i) => i + 1)}
                  className="px-5 py-2 rounded-md bg-forest text-white text-sm font-medium hover:bg-forest-deep"
                >
                  Continue
                </button>
              )}
            </div>
            <div className="flex gap-2 text-xs">
              <button
                onClick={() => {
                  setProgress({ ...progress, skipped: true });
                  saveProgress(progress.done, true);
                }}
                className="text-ink-muted underline underline-offset-2 hover:text-ink"
              >
                Skip all
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

export default OnboardingWizard;
