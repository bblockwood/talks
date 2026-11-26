// Bundled test decks for development and e2e. Imported only when import.meta.env.DEV is true.
import basicUrl from "../../fixtures/basic-169.pdf?url";
import linksUrl from "../../fixtures/links-appendix.pdf?url";
import overlaysUrl from "../../fixtures/overlays.pdf?url";
import tikzUrl from "../../fixtures/tikz-heavy.pdf?url";

export const FIXTURES: readonly { name: string; url: string }[] = [
  { name: "Basic 16:9", url: basicUrl },
  { name: "Overlays (builds)", url: overlaysUrl },
  { name: "Links and appendix", url: linksUrl },
  { name: "TikZ heavy", url: tikzUrl },
];
