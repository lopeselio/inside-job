import type { StationId } from './map.ts';

// Everything named in the game: payees, duties, the AI council and the numbers that balance a match.

export const TICK_HZ = 10;

/** Credits. One credit is 0.001 NEAR of real testnet money in the DAO. */
export const BUDGET = 100;
export const DRAIN_GOAL = 25;
export const FLAG_CAP = 8;
export const HARD_CAP = 15;
export const BURST_TICKS = 200;
export const MAX_SPENDS = 16;
export const APPROVALS = 3;

export const SPEED = 0.3;
export const FREEZE_RANGE = 1.6;
export const REPORT_RANGE = 2.6;
export const VISION = 6.5;
export const VISION_DARK = 2.4;
export const FREEZE_CD = 600;
export const FREEZE_FIRST = 380;
export const SKIM_CD = 240;
export const SKIM_FIRST = 150;
export const LIGHTS_CD = 500;
export const LIGHTS_FIRST = 300;
export const LIGHTS_TIME = 250;
export const SESSION_EVERY = 750;
export const DISCUSS_TICKS = 350;
export const VOTE_TICKS = 220;
export const REVEAL_TICKS = 70;
export const PLAY_LIMIT = 4800;
export const DUTIES_EACH = 5;
export const SKIM_MIN = 4;
export const SKIM_MAX = 12;

/** Vendors already on file with the DAO. */
export const VENDORS = ['lumen-power', 'quill-legal', 'nightowl-guard', 'stackhouse-cloud'] as const;
/** Real, honest vendors that are new this quarter: payroll invoices to them look like a drain to a skim reader. */
export const NEW_VENDORS = ['brightline-print', 'copperkettle-cafe', 'tidewater-courier', 'oakmoss-cleaning'] as const;
/** The Insider's shell companies: plausible new names. */
export const SHELLS = ['harborline-supply', 'granite-consult', 'velvet-ops', 'northpeak-data'] as const;
/** The Insider's lookalikes of vendors on file. */
export const LOOKALIKES = ['lumen-powr', 'quil-legal', 'night0wl-guard', 'stackhouse-c1oud'] as const;
export const ALL_PAYEES: string[] = [...VENDORS, ...NEW_VENDORS, ...SHELLS, ...LOOKALIKES];
export const SKIM_PAYEES: string[] = [...SHELLS, ...LOOKALIKES];

export const PAYEE_LABEL: Record<string, string> = {
  'lumen-power': 'Lumen Power Co.', 'quill-legal': 'Quill & Partners Legal', 'nightowl-guard': 'Night Owl Security', 'stackhouse-cloud': 'Stackhouse Cloud',
  'brightline-print': 'Brightline Print', 'copperkettle-cafe': 'Copper Kettle Café', 'tidewater-courier': 'Tidewater Courier', 'oakmoss-cleaning': 'Oakmoss Cleaning',
  'harborline-supply': 'Harborline Supply', 'granite-consult': 'Granite Consulting', 'velvet-ops': 'Velvet Ops Ltd', 'northpeak-data': 'Northpeak Data',
  'lumen-powr': 'Lumen Power Co.', 'quil-legal': 'Quill & Partners Legal', 'night0wl-guard': 'Night Owl Security', 'stackhouse-c1oud': 'Stackhouse Cloud',
};

export type DutyKind = 'reserves' | 'keys' | 'node' | 'files' | 'mail' | 'coffee' | 'payroll';
export interface DutyDef { kind: DutyKind; station: StationId; name: string; ticks: number; how: string }
export const DUTIES: DutyDef[] = [
  { kind: 'reserves', station: 'terminal', name: 'Count the reserves', ticks: 30, how: 'Tap the coin stacks from smallest to largest.' },
  { kind: 'keys', station: 'keys', name: 'Rotate the vault key', ticks: 25, how: 'Turn the dial to each number of the new code.' },
  { kind: 'node', station: 'node', name: 'Patch the validator', ticks: 35, how: 'Connect each wire to the port of the same colour.' },
  { kind: 'files', station: 'files', name: 'File the receipts', ticks: 30, how: 'Drop each receipt in the drawer of its month.' },
  { kind: 'mail', station: 'mail', name: 'Sort the mail', ticks: 25, how: 'Send each letter to its department.' },
  { kind: 'coffee', station: 'coffee', name: 'Brew the night coffee', ticks: 30, how: 'Hold the lever until the cup is full, then let go.' },
  { kind: 'payroll', station: 'payroll', name: 'Prepare a vendor invoice', ticks: 30, how: 'Match the invoice to the vendor’s exact account. Approved at the Audit desk or in a meeting, it counts.' },
];
export const dutyDef = (k: DutyKind): DutyDef => DUTIES.find((d) => d.kind === k)!;

export type Trait = 'careful' | 'careless' | 'steady';
export interface Persona { id: string; name: string; trait: Trait; persona: string; color: number }

/** The AI council. Each sits at a desk account (seat1…seat5.<contract>) when it plays. */
export const PERSONAS: Persona[] = [
  { id: 'wren', name: 'Wren', trait: 'careful', color: 0x5ec8e5, persona: 'Wren, the council’s meticulous auditor, who talks in short exact sentences and always cites numbers' },
  { id: 'basil', name: 'Basil', trait: 'careless', color: 0xf2a541, persona: 'Basil, the friendly operations lead, chatty and quick to trust, fond of a joke' },
  { id: 'sable', name: 'Sable', trait: 'careful', color: 0xb07cf0, persona: 'Sable, the dry, unimpressed head of security, who suspects everyone a little' },
  { id: 'pax', name: 'Pax', trait: 'careless', color: 0x7bd88f, persona: 'Pax, a nervous junior accountant, who apologises and second-guesses themself' },
  { id: 'otto', name: 'Otto', trait: 'steady', color: 0xef6f6c, persona: 'Otto, the old-school treasurer, formal and fond of procedure' },
];

/** Seat colours, by seat index (humans and AI alike take the seat's colour). */
export const SEAT_COLORS = [0x5ec8e5, 0xf2a541, 0xb07cf0, 0x7bd88f, 0xef6f6c];
