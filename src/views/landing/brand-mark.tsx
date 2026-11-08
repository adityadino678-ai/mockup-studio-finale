"use client";

export interface BrandMarkProps {
  size?: number;
  href?: string;
  className?: string;
}

const FILTER_ID = "brandmark-rough";

export function BrandMark({
  size = 28,
  href,
  className,
}: BrandMarkProps) {
  const wrapperClass = `flex items-center gap-2 text-ink hover:text-forest transition-colors no-underline${className ? ` ${className}` : ""}`;

  const content = (
    <>
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <filter
            id={FILTER_ID}
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.08"
              numOctaves="3"
              result="noise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale="5"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
        <path
          d="M15 20 Q 25 10 40 20 Q 55 30 60 50 Q 55 70 40 80 Q 25 90 15 80 Q 5 70 15 50 Q 10 30 15 20"
          stroke="currentColor"
          strokeWidth="4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={`url(#${FILTER_ID})`}
        />
        <circle
          cx="35"
          cy="45"
          r="6"
          fill="currentColor"
          filter={`url(#${FILTER_ID})`}
        />
        <circle
          cx="50"
          cy="55"
          r="6"
          fill="currentColor"
          filter={`url(#${FILTER_ID})`}
        />
        <circle
          cx="65"
          cy="45"
          r="6"
          fill="currentColor"
          filter={`url(#${FILTER_ID})`}
        />
      </svg>
      <span
        style={{ fontFamily: "var(--font-display)" }}
        className="text-[15px] font-bold uppercase tracking-[0.14em] text-ink"
      >
        ListBulkly
      </span>
    </>
  );

  if (href) {
    return <a href={href} className={wrapperClass}>{content}</a>;
  }
  return <span className={wrapperClass}>{content}</span>;
}

export default BrandMark;
