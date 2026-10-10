import { createRoot } from "react-dom/client";
import { ComposedReferenceGameApp } from "./components/ComposedReferenceGameApp";
import "./style.css";

/**
 * The one browser entry point.
 *
 * This product ships a single frontend, so the fragment marker is a fixed
 * identity rather than a surface selector: the Host generates it
 * (`#profile=composed-reference-game&boot=…`), the app keeps it across the
 * one-time bootstrap redeem, and a reload re-selects the same app through the
 * session cookie. A fragment that does not name this product's own identity is
 * not this product's surface, so nothing is mounted for it.
 */
const PROFILE = "composed-reference-game";

const rootElement = document.getElementById("root");
if (rootElement) {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  if (hashParams.get("profile") === PROFILE) {
    createRoot(rootElement).render(<ComposedReferenceGameApp />);
  }
}
