import { createRoot } from "react-dom/client";
import { ReferenceApp } from "./components/ReferenceApp";
import "./style.css";

const rootElement = document.getElementById("root");
if (rootElement) {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const profile = hashParams.get("profile");
  if (profile === "reference") {
    createRoot(rootElement).render(<ReferenceApp />);
  } else if (profile === "composed-reference-game") {
    const { ComposedReferenceGameApp } = await import("./components/ComposedReferenceGameApp");
    createRoot(rootElement).render(<ComposedReferenceGameApp />);
  } else if (profile === "management") {
    const { ManagementApp } = await import("./components/ManagementApp");
    createRoot(rootElement).render(<ManagementApp />);
  }
}
