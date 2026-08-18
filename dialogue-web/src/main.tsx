import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import { ReferenceApp } from "./components/ReferenceApp";
import "./style.css";

const rootElement = document.getElementById("root");
if (rootElement) {
  // The immutable shell serves only path "/" (the static handler rejects
  // query strings), so the profile marker lives in the fragment. The default
  // (no marker, matching the P3 composition) keeps the P3 App unchanged.
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const profile = searchParams.get("profile") ?? hashParams.get("profile");
  if (profile === "reference") {
    createRoot(rootElement).render(<ReferenceApp />);
  } else if (profile === "management") {
    const { ManagementApp } = await import("./components/ManagementApp");
    createRoot(rootElement).render(<ManagementApp />);
  } else {
    createRoot(rootElement).render(<App />);
  }
}