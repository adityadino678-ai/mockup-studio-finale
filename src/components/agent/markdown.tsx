"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

function textOf(node: React.ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children);
  return "";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border border-border-subtle bg-surface/90 text-ink-subtle opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      title="Copy code"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Renders assistant markdown with GitHub-flavored tables, syntax highlighting, and code copy buttons. */
export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("agent-markdown text-[13px] leading-relaxed text-ink", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-1">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          h1: ({ children }) => <h1 className="mb-2 mt-3 text-[15px] font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-3 text-[14px] font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-[13px] font-semibold">{children}</h3>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-forest underline">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border-strong pl-3 text-ink-muted">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border-subtle px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border border-border-subtle px-2 py-1">{children}</td>,
          pre: ({ children }) => (
            <div className="group relative my-2">
              <pre className="overflow-x-auto rounded-md border border-border-subtle bg-surface-muted p-3 text-[12px] leading-relaxed">
                {children}
              </pre>
              <CopyButton text={textOf(children)} />
            </div>
          ),
          code: ({ className: codeClass, children, ...props }) => {
            const isBlock = /language-|hljs/.test(codeClass ?? "");
            if (isBlock) {
              return (
                <code className={codeClass} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-surface-muted px-1 py-0.5 text-[12px]" {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
