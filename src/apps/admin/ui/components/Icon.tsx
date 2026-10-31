export type IconName =
  | "overview"
  | "revenue"
  | "activity"
  | "users"
  | "jobs"
  | "waitlist"
  | "audit"
  | "menu"
  | "close"
  | "refresh"
  | "copy"
  | "check"
  | "sun"
  | "moon"
  | "system"
  | "signout"
  | "back"
  | "download"
  | "lock";

/** 16px stroke icons drawn for this console; decorative, so always hidden from assistive tech. */
const PATHS: Record<IconName, string[]> = {
  overview: ["M2.5 2.5h4.5v5.5H2.5z", "M9 2.5h4.5v3H9z", "M9 8h4.5v5.5H9z", "M2.5 10h4.5v3.5H2.5z"],
  revenue: [
    "M8 1.8v12.4",
    "M10.6 4.6C10.2 3.7 9.3 3.2 8 3.2c-1.6 0-2.7.8-2.7 2 0 3 5.4 1.6 5.4 4.6 0 1.2-1.1 2-2.7 2-1.4 0-2.4-.6-2.8-1.6",
  ],
  activity: ["M1.8 8.4h2.6l1.8-4.8 3.4 8.8 1.8-4h2.8"],
  users: [
    "M8 7.4a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z",
    "M2.8 13.8c.4-2.5 2.6-3.8 5.2-3.8s4.8 1.3 5.2 3.8",
  ],
  jobs: ["M2.2 4h11.6", "M2.2 8h11.6", "M2.2 12h7", "M12.4 11l1 1 2-2.2"],
  waitlist: ["M2 3.5h12v9H2z", "M2.4 4l5.6 4.6L13.6 4"],
  audit: ["M3.5 1.8h6.2l3 3v9.4h-9.2z", "M9.5 1.8v3.2h3.2", "M5.6 8h4.8", "M5.6 10.6h4.8"],
  menu: ["M2.5 4.5h11", "M2.5 8h11", "M2.5 11.5h11"],
  close: ["M3.5 3.5l9 9", "M12.5 3.5l-9 9"],
  refresh: ["M13.4 8a5.4 5.4 0 1 1-1.6-3.8", "M13.6 2.2v3h-3"],
  copy: ["M5.5 5.5h7.2v8.2H5.5z", "M3.3 10.5V2.8h7.2"],
  check: ["M3 8.4l3.2 3.2L13 4.6"],
  sun: [
    "M8 10.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z",
    "M8 1.6v1.4",
    "M8 13v1.4",
    "M1.6 8H3",
    "M13 8h1.4",
    "M3.5 3.5l1 1",
    "M11.5 11.5l1 1",
    "M12.5 3.5l-1 1",
    "M4.5 11.5l-1 1",
  ],
  moon: ["M13.2 9.4A5.6 5.6 0 0 1 6.6 2.8 5.6 5.6 0 1 0 13.2 9.4z"],
  system: ["M2 3h12v7.6H2z", "M5.6 13.4h4.8", "M8 10.6v2.8"],
  signout: ["M6.4 2.6H3.2v10.8h3.2", "M10 5.2L13 8l-3 2.8", "M13 8H6.2"],
  back: ["M9.6 3.4L5 8l4.6 4.6"],
  download: ["M8 2v8.4", "M4.8 7.4L8 10.6l3.2-3.2", "M2.6 13.4h10.8"],
  lock: ["M3.6 7.2h8.8v6.2H3.6z", "M5.4 7.2V5a2.6 2.6 0 0 1 5.2 0v2.2"],
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
