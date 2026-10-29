import Image from "next/image";

/** The ATC logo, wherever the app shows or prints it — always the official
 *  horizontal one: the mark with the company's name beside it, never under
 *  it. `white` is for the green bar and other dark grounds. Size it by its
 *  height (a class); the width follows. `eager` loads it at once — for a
 *  logo that is hidden until printed, or the first thing a page shows. */
export function BrandLogo({ white = false, eager = false, alt = "ATC — Arabian Transformers Co.", className }: {
  white?: boolean;
  eager?: boolean;
  alt?: string;
  className?: string;
}) {
  return (
    <Image
      src={white ? "/brand/atc-logo-horizontal-white.svg" : "/brand/atc-logo-horizontal.svg"}
      alt={alt}
      width={266}
      height={32}
      className={className}
      {...(eager ? { loading: "eager", fetchPriority: "high" } : {})}
    />
  );
}
