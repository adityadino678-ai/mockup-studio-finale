import * as React from "react";
import {
  InkDraw,
  InkWash,
  Marquee,
  PartHeader,
  SketchAppShell,
  SketchButton,
  SketchCheckbox,
  SketchDialog,
  SketchEmpty,
  SketchFooter,
  SketchInput,
  SketchNav,
  SketchRange,
  SketchRow,
  SketchRows,
  SketchSeg,
  SketchSelect,
  SketchSkeleton,
  SketchTextarea,
  SketchToastProvider,
  Tee3D,
  TeeLoader,
  useSketchToast,
} from "@/components/sketch";
import {
  SLOGAN_DEFAULT,
  SLOGAN_MAX_LENGTH,
  clampSlogan,
} from "@/lib/sketch/slogan";
import { BRAND } from "@/config/brand";

const NAV_LINKS = [
  { href: "#tokens", label: "Tokens" },
  { href: "#components", label: "Components" },
  { href: "#tee", label: "Tee" },
  { href: "#motion", label: "Motion" },
];

function Section({
  id,
  number,
  title,
  note,
  children,
}: {
  id: string;
  number: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="sk-container sk-section" aria-labelledby={`${id}-title`}>
      <span className="sk-cap">{number}</span>
      <h2 className="sk-part-title" id={`${id}-title`}>
        {title}
      </h2>
      {note ? <p className="sk-note sk-note--sm">{note}</p> : null}
      <div className="sk-demo">{children}</div>
    </section>
  );
}

function Swatch({ token, hex }: { token: string; hex: string }) {
  return (
    <div>
      <div
        className="sk-swatch__chip"
        style={{ background: `var(${token})` }}
        aria-hidden="true"
      />
      <p>
        <strong>var({token})</strong>
      </p>
      <p className="sk-muted">{hex}</p>
    </div>
  );
}

function DialogDemo() {
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"up" | "in">("up");
  const { push } = useSketchToast();

  return (
    <>
      <SketchButton onClick={() => setOpen(true)}>Open the dialog</SketchButton>
      <SketchDialog
        open={open}
        onClose={() => setOpen(false)}
        title={mode === "up" ? "Sign up" : "Log in"}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(false);
            push("Demo only — accounts arrive in Phase 4.", "info");
          }}
        >
          <div className="sk-stack">
            <SketchSeg
              ariaLabel="Choose sign up or log in"
              value={mode}
              onChange={setMode}
              options={[
                { value: "up", label: "Sign up" },
                { value: "in", label: "Log in" },
              ]}
            />
            <SketchInput
              label="Email"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
            <SketchInput
              label="Password"
              name="password"
              type="password"
              minLength={8}
              autoComplete={mode === "up" ? "new-password" : "current-password"}
              required
            />
            <SketchButton type="submit" block>
              {mode === "up" ? "Create account" : "Log in"}
            </SketchButton>
          </div>
        </form>
      </SketchDialog>
    </>
  );
}

function ToastDemo() {
  const { push } = useSketchToast();
  return (
    <div className="sk-cluster">
      <SketchButton size="sm" onClick={() => push("Render saved to this listing.", "success")}>
        Success toast
      </SketchButton>
      <SketchButton
        size="sm"
        variant="outline"
        onClick={() => push("Printify rejected the key (401).", "error")}
      >
        Error toast
      </SketchButton>
      <SketchButton size="sm" variant="outline" onClick={() => push("Nothing publishes by itself.", "info")}>
        Info toast
      </SketchButton>
    </div>
  );
}

function TeeDemo() {
  const [slogan, setSlogan] = React.useState(SLOGAN_DEFAULT);
  return (
    <div className="sk-grid sk-grid--2">
      <InkDraw>
        <Tee3D slogan={slogan} note="your slogan, here" />
      </InkDraw>
      <div className="sk-stack">
        <label className="sk-try">
          Type your slogan. Watch it land on the tee.
          <input
            className="sk-input"
            value={slogan}
            maxLength={SLOGAN_MAX_LENGTH}
            autoComplete="off"
            aria-label="Your slogan"
            onChange={(event) => setSlogan(clampSlogan(event.target.value))}
          />
        </label>
        <p className="sk-muted">
          Always three lines. The middle line sits on an orange block. Never a sun
          or a generic icon.
        </p>
        <div className="sk-grid sk-grid--2">
          <div>
            <p className="sk-cap">Fixed angle</p>
            <Tee3D slogan="Good vibes only" mode="fixed" backdrop={false} />
          </div>
          <div>
            <p className="sk-cap">Loader</p>
            <TeeLoader label="Loading the tee demo" />
          </div>
        </div>
      </div>
    </div>
  );
}

function StyleguideContent() {
  const [range, setRange] = React.useState(40);
  const [seg, setSeg] = React.useState<"designs" | "colours">("designs");

  return (
    <>
      <SketchNav links={NAV_LINKS} loginHref="#dialog" signupHref="#dialog" />

      <header className="sk-container sk-section">
        <span className="sk-cap">ListBulkly · The Sketchbook</span>
        <h1 className="sk-part-title" style={{ fontSize: "var(--text-3xl)" }}>
          Design system
        </h1>
        <p style={{ maxWidth: "var(--measure)" }}>
          Cream paper, black ink, one blue, one orange. Every colour, font, space
          and duration on this page comes from <code>tokens.css</code>. This page is
          internal and <code>noindex</code>.
        </p>
      </header>

      <Section id="tokens" number="01 / Tokens" title="Five colours. Nothing else.">
        <div className="sk-grid sk-grid--3">
          <Swatch token="--paper" hex={BRAND.paper} />
          <Swatch token="--ink" hex={BRAND.ink} />
          <Swatch token="--blue" hex={BRAND.blue} />
          <Swatch token="--orange" hex={BRAND.orange} />
          <Swatch token="--wash" hex={BRAND.wash} />
        </div>
        <p className="sk-muted">
          Orange is for large display text, stripes and buttons. Body copy is ink on
          paper; text on blue is paper. No gradients.
        </p>
      </Section>

      <Section id="type" number="02 / Type" title="Josefin Sans + Caveat, self-hosted">
        <div className="sk-stack">
          <p style={{ fontSize: "var(--text-3xl)", fontWeight: 700, letterSpacing: "var(--tracking-display)", textTransform: "uppercase" }}>
            Heading 700
          </p>
          <p style={{ fontSize: "var(--text-xl)", fontWeight: 700, letterSpacing: "var(--tracking-display)", textTransform: "uppercase" }}>
            Section heading
          </p>
          <p style={{ fontSize: "var(--text-base)" }}>
            Body 400 — upload your art, match real mockups, write your listings once,
            then send. Nothing publishes until you say so.
          </p>
          <p className="sk-note">Caveat 500 — a handwritten margin note.</p>
          <p className="sk-muted">Small / muted — used for hints and secondary meta.</p>
        </div>
        <div className="sk-grid sk-grid--3" style={{ marginTop: "var(--space-6)" }}>
          {["--space-2", "--space-4", "--space-8"].map((token) => (
            <div key={token}>
              <div className="sk-space-bar" style={{ width: `var(${token})` }} aria-hidden="true" />
              <p className="sk-muted">var({token})</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="components" number="03 / Buttons" title="Ink rectangles that tilt">
        <div className="sk-cluster">
          <SketchButton>Start free</SketchButton>
          <SketchButton variant="outline">What’s it costing me?</SketchButton>
          <SketchButton size="sm">Small</SketchButton>
          <SketchButton size="lg">Large</SketchButton>
          <SketchButton loading>Sending</SketchButton>
          <SketchButton disabled>Disabled</SketchButton>
        </div>
        <div style={{ marginTop: "var(--space-4)", maxWidth: "22rem" }}>
          <SketchButton block>Full width</SketchButton>
        </div>
      </Section>

      <Section id="forms" number="04 / Forms" title="Underlines, not boxes">
        <div className="sk-grid sk-grid--2">
          <SketchInput label="Printify API key" type="password" hint="Stored encrypted. Never shown again after saving." />
          <SketchInput
            label="Shop ID"
            defaultValue="12345"
            error="Printify rejected this key (401). Check it and try again."
          />
          <SketchInput label="Disabled" disabled defaultValue="Read only" />
          <SketchSelect label="Product type" defaultValue="tee">
            <option value="tee">T-shirt</option>
            <option value="hoodie">Hoodie</option>
            <option value="mug">Mug</option>
          </SketchSelect>
          <SketchTextarea label="Description" hint="Up to 5000 characters go to Printify." />
          <div className="sk-stack">
            <SketchRange
              label="Designs you list per week"
              min={5}
              max={200}
              value={range}
              display={range}
              onChange={(event) => setRange(Number(event.target.value))}
            />
            <SketchCheckbox label="Apply to every design" />
            <SketchSeg
              ariaLabel="Studio tab"
              value={seg}
              onChange={setSeg}
              options={[
                { value: "designs", label: "Designs" },
                { value: "colours", label: "Colours" },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section id="rows" number="05 / Hairline lists" title="Rules instead of cards">
        <SketchRows>
          <SketchRow title="Nothing goes live by itself">
            <p>Send stops at an unpublished draft. Publish now is its own click.</p>
          </SketchRow>
          <SketchRow title="A checklist that tells the truth">
            <p>It lists what Printify is missing and links to the page that fixes it.</p>
          </SketchRow>
        </SketchRows>
        <div style={{ marginTop: "var(--space-8)" }}>
          <div className="sk-plan">
            <h3>
              <span>/</span>Pro monthly
            </h3>
            <ul>
              <li>Bigger batches (PLACEHOLDER limit)</li>
              <li>One-click mockup apply with the extension</li>
              <li>Batch templates across every listing</li>
            </ul>
            <SketchButton variant="outline" href="#dialog">
              Go Pro
            </SketchButton>
          </div>
        </div>
      </Section>

      <Section id="faq" number="06 / FAQ" title="Plus and minus">
        <details className="sk-faq">
          <summary>Will it publish by itself?</summary>
          <p>No. Send creates or updates a draft on Printify. Publishing is a separate click.</p>
        </details>
        <details className="sk-faq">
          <summary>Do I need an Etsy API key?</summary>
          <p>No. Only the Printify API is used, with your own key and shop ID.</p>
        </details>
      </Section>

      <Section id="dialog" number="07 / Dialog" title="Paper with an orange shadow" note="Escape, backdrop click and the close button all dismiss it.">
        <DialogDemo />
      </Section>

      <Section id="toasts" number="08 / Toasts" title="Success, error, info">
        <ToastDemo />
      </Section>

      <Section id="skeletons" number="09 / Skeletons" title="Loading without a shimmer">
        <SketchSkeleton lines={3} height="1.25rem" label="Loading example content" />
      </Section>

      <Section id="drawing" number="10 / Ink drawing" title="Strokes draw themselves in">
        <InkDraw className="sk-art">
          <svg viewBox="0 0 400 320" role="img" aria-label="Three doodles dropping into a drop zone">
            <path
              className="sk-f"
              style={{ "--i": 0 } as React.CSSProperties}
              fill="var(--wash)"
              filter="url(#sk-rough)"
              d="M60 40Q200 0 350 50T340 250Q200 300 70 260T60 40Z"
            />
            <path className="sk-d" style={{ "--i": 1 } as React.CSSProperties} pathLength={1} d="M40 80l95-8 6 100-98 10z" />
            <path className="sk-d sk-d--orange" style={{ "--i": 2 } as React.CSSProperties} pathLength={1} d="M70 122a20 20 0 1 0 40 0a20 20 0 1 0-40 0" />
            <path className="sk-d" style={{ "--i": 2 } as React.CSSProperties} pathLength={1} d="M150 110l95 6-8 100-92-6z" />
            <path className="sk-d sk-d--blue" style={{ "--i": 3 } as React.CSSProperties} pathLength={1} d="M170 180q15-24 30 0t30 0" />
            <path className="sk-d" style={{ "--i": 3 } as React.CSSProperties} pathLength={1} d="M262 62l92 10-12 96-90-12z" />
            <path className="sk-d sk-d--orange" style={{ "--i": 4 } as React.CSSProperties} pathLength={1} d="M308 90l6 14 15 1-11 10 4 15-14-8-13 8 4-15-11-10 15-1z" />
            <path className="sk-d" style={{ "--i": 5 } as React.CSSProperties} pathLength={1} d="M200 20v30m-10-10l10 12 10-12" />
            <path className="sk-s" d="M30 275H370" />
          </svg>
        </InkDraw>
      </Section>

      <Section id="wash" number="11 / Ink wash" title="Rough blobs, three tones">
        <div className="sk-grid sk-grid--3">
          <InkWash tone="wash" />
          <InkWash tone="blue" opacity={0.85} />
          <InkWash tone="orange" opacity={0.85} />
        </div>
      </Section>

      <Section id="marquee" number="12 / Marquee" title="One blue band, tilted">
        <Marquee />
      </Section>

      <Section id="tee" number="13 / Signature tee" title="Your slogan, three lines">
        <TeeDemo />
        <div style={{ marginTop: "var(--space-8)" }}>
          <SketchEmpty
            title="No renders yet"
            note="map a print area, then save a render"
            action={<SketchButton href="/mockups" size="sm">Open Mockups</SketchButton>}
          />
        </div>
      </Section>

      <Section id="parts" number="14 / Parts" title="Numbered 01 to 06">
        <div className="sk-spread" style={{ padding: "var(--space-8) 0" }}>
          <PartHeader
            number="01"
            title="Create"
            caption="One Printify product per design."
            how="How to use it: upload your art, pick the product and colours, and place the print."
          />
          <InkDraw className="sk-art">
            <InkWash tone="wash" />
          </InkDraw>
        </div>
      </Section>

      <Section id="shell" number="15 / App shell" title="Dense tools, same sketchbook">
        <div className="sk-demo-shell">
          <SketchAppShell
            title="Printify Studio"
            hint="part 01 — upload, pick colours, place the print"
            activeHref="/printify-studio"
            links={[
              { href: "/printify-studio", label: "Studio" },
              { href: "/mockups", label: "Mockups" },
              { href: "/listing-images", label: "Listing images" },
              { href: "/listing-details", label: "Listing details" },
              { href: "/listing-preview", label: "Listing preview" },
              { href: "/settings", label: "Settings" },
            ]}
            actions={<SketchButton size="sm">Create on Printify</SketchButton>}
          >
            <SketchRows>
              <SketchRow title="Design 01">
                <p>Artwork, placement and colours stay in the existing engine.</p>
              </SketchRow>
              <SketchRow title="Design 02">
                <p>The shell only changes how the tool looks, never what it does.</p>
              </SketchRow>
            </SketchRows>
          </SketchAppShell>
        </div>
      </Section>

      <Section id="motion" number="16 / Motion" title="Draw, fade, one loop per scene">
        <div className="sk-stack">
          <p>
            Only <code>transform</code>, <code>opacity</code> and <code>stroke</code> are
            animated. Scenes render fully drawn on the server, so a failed script never
            leaves a blank page.
          </p>
          <p>
            Turn on your operating system’s <strong>reduce motion</strong> setting and
            reload: every stroke is already drawn, the marquee stops and the tee holds
            still.
          </p>
          <p className="sk-muted">
            Grain is active over this whole page. The footer legal links now point at
            real drafts (/privacy, /terms, /refunds, /cookies, /contact) and the
            sign-up dialog calls the app&apos;s /api/auth endpoints. Pricing is still
            PLACEHOLDER, and the auth dialog is the only account surface here.
          </p>
        </div>
      </Section>

      <SketchFooter />
    </>
  );
}

export function StyleguidePage() {
  return (
    <SketchToastProvider>
      <StyleguideContent />
    </SketchToastProvider>
  );
}
