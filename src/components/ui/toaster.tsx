"use client";

import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      toastOptions={{
        style: {
          background: "#ffffff",
          border: "1px solid #e6e7e0",
          color: "#252a26",
          fontSize: "13px",
          boxShadow: "0 8px 24px rgba(37,42,38,0.1)",
        },
      }}
    />
  );
}
