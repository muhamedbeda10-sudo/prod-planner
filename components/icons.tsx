import type { SVGProps } from "react";

/** Custom process icons in the lucide stroke style (24×24, stroke 2,
 *  currentColor) so they drop in anywhere a lucide icon fits. */

type IconProps = { size?: number; className?: string } & SVGProps<SVGSVGElement>;

function base(size?: number, className?: string) {
  return {
    width: size ?? 24,
    height: size ?? 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
  };
}

/** Fabrication — a laser cutting machine: gantry rail, cutting head, dashed
 *  beam hitting the bed with sparks. */
export function LaserCutterIcon({ size, className, ...rest }: IconProps) {
  return (
    <svg {...base(size, className)} {...rest} aria-hidden>
      {/* nozzle cone, dashed beam, and the workpiece SPLIT where the beam cuts */}
      <path d="M9 2h6v3.5L13 9h-2L9 5.5z" />
      <path d="M12 10.5v4" strokeDasharray="0.5 3" />
      <path d="M4 19h5.5" />
      <path d="M14.5 19h5.5" />
      <path d="M8.5 15.5 7 17" />
      <path d="m15.5 15.5 1.5 1.5" />
    </svg>
  );
}

/** Welding — the welder's mask with the visor slit. */
export function WeldingIcon({ size, className, ...rest }: IconProps) {
  return (
    <svg {...base(size, className)} {...rest} aria-hidden>
      <path d="M6 3h12v9a6 6 0 0 1-12 0z" />
      <path d="M9 9.5h6" />
      <path d="M12 2v1" />
      <path d="M4 21c2.5-2.2 13.5-2.2 16 0" />
    </svg>
  );
}

/** Painting — powder-coating spray gun: body, nozzle and the powder cloud. */
export function PowderCoatIcon({ size, className, ...rest }: IconProps) {
  return (
    <svg {...base(size, className)} {...rest} aria-hidden>
      <path d="M3 5h7l2 3-2 3H3z" />
      <path d="M5 11v6a2 2 0 0 0 2 2h1" />
      <path d="M12 8h2" />
      <path d="M17.5 5.5v.01" />
      <path d="M20 8v.01" />
      <path d="M17.5 10.5v.01" />
      <path d="M20.5 12.5v.01" />
      <path d="M18 13.5v.01" />
    </svg>
  );
}
