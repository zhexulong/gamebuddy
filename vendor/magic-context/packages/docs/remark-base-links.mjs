import { visit } from "unist-util-visit";

/**
 * Prefixes the Astro `base` onto root-absolute internal links in Markdown
 * bodies (`/concepts/memory/` -> `/magic-context/concepts/memory/`).
 *
 * Authors keep writing clean site-absolute paths (see STYLE.md); the base is
 * a deployment detail applied at build time. Frontmatter links (hero actions)
 * are NOT covered — those must carry the base explicitly.
 */
export function remarkBaseLinks({ base }) {
    const prefix = base.replace(/\/$/, "");
    return () => (tree) => {
        visit(tree, "link", (node) => {
            if (node.url.startsWith("/") && !node.url.startsWith(`${prefix}/`)) {
                node.url = `${prefix}${node.url}`;
            }
        });
    };
}
