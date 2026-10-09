import type { AnchorHTMLAttributes } from "react";
import { onLinkClick } from "../router";

export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...props} onClick={(e) => (props.onClick?.(e), onLinkClick(e))} />;
}
