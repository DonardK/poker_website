"use client";

import { useEffect } from "react";

/**
 * Replaces the root layout, so it carries its own document and colours.
 * The copy matches the rest of the site: play chips, and a way back to the lobby.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem 1rem",
          background: "radial-gradient(ellipse at top, #143d31 0%, #071912 55%, #050d0a 100%)",
          color: "#f4efe4",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          textAlign: "center",
        }}
      >
        <main style={{ maxWidth: "28rem" }}>
          <p style={{ letterSpacing: "0.2em", textTransform: "uppercase", color: "#fde68a", fontSize: "0.875rem" }}>
            Something went wrong
          </p>
          <h1 style={{ fontSize: "2rem", margin: "0.75rem 0" }}>Hold&apos;em Live hit an error</h1>
          <p style={{ color: "#ecfdf5", lineHeight: 1.5 }}>
            Play chips only — no real money. You can try again, or return to the lobby.
          </p>
          {error.digest ? (
            <p style={{ color: "#ecfdf5", fontSize: "0.875rem" }}>Reference {error.digest}</p>
          ) : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", justifyContent: "center", marginTop: "1.5rem" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                minHeight: "3rem",
                border: 0,
                borderRadius: "999px",
                background: "#fcd34d",
                color: "#022c22",
                fontWeight: 650,
                padding: "0.75rem 1.5rem",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                minHeight: "3rem",
                display: "inline-flex",
                alignItems: "center",
                borderRadius: "999px",
                border: "1px solid rgba(253, 230, 138, 0.45)",
                color: "#fef3c7",
                fontWeight: 650,
                padding: "0.75rem 1.5rem",
                textDecoration: "none",
              }}
            >
              Back to the lobby
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
