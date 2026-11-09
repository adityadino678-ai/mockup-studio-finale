"use client";

import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      toastOptions={{
        style: {
          background: "#F7F3EC",
          border: "2px solid #15110E",
          borderRadius: "0",
          color: "#15110E",
          fontSize: "13px",
          fontWeight: 600,
          boxShadow: "6px 6px 0 #E8702A",
        },
      }}
    />
  );
}
