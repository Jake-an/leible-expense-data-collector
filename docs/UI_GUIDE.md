# UI Design Guide

## Design Principles
1. {Principle 1 — e.g. "Should look like a tool. A dashboard you use every day, not a marketing page."}
2. {Principle 2}
3. {Principle 3}

## AI Slop Anti-Patterns — Do Not Use
| Prohibited | Reason |
|------------|--------|
| backdrop-filter: blur() | Glass morphism is the most common sign of an AI template |
| gradient-text (background gradient text) | #1 trait of AI-generated SaaS landings |
| "Powered by AI" badge | Decoration, not function. No value to the user |
| box-shadow glow animation | Neon glow = AI slop |
| Purple/indigo brand colors | "AI = purple" cliché |
| Identical rounded-2xl on every card | Uniform rounded corners feel like a template |
| Background gradient orb (blur-3xl circle) | Present on every AI landing page |

## Colors
### Background
| Use | Value |
|-----|-------|
| Page | {e.g. #0a0a0a} |
| Card | {e.g. #141414} |

### Text
| Use | Value |
|-----|-------|
| Primary text | {e.g. text-white} |
| Body | {e.g. text-neutral-300} |
| Secondary | {e.g. text-neutral-400} |
| Inactive | {e.g. text-neutral-500} |

### Data / Semantic Colors
| Use | Value |
|-----|-------|
| {Positive/Success} | {e.g. #22c55e} |
| {Negative/Error} | {e.g. #ef4444} |
| {Neutral/Default} | {e.g. #525252} |

## Components
### Card
```
{e.g. rounded-lg bg-[#141414] border border-neutral-800 p-6}
```

### Button
```
Primary: {e.g. rounded-lg bg-white text-black hover:bg-neutral-200}
Text:    {e.g. text-neutral-500 hover:text-neutral-300}
```

### Input Field
```
{e.g. rounded-lg bg-neutral-900 border border-neutral-800 px-4 py-3}
```

## Layout
- Max width: {e.g. max-w-5xl}
- Alignment: {e.g. Left-aligned by default. No center alignment.}
- Spacing: {e.g. gap-3~4, space-y-8 between sections}

## Typography
| Use | Style |
|-----|-------|
| Page title | {e.g. text-4xl font-semibold text-white} |
| Card title | {e.g. text-sm font-medium text-neutral-400} |
| Body | {e.g. text-sm text-neutral-300 leading-relaxed} |

## Animation
- {List only permitted animations. e.g. fade-in (0.4s), slide-up (0.5s)}
- {All other animations prohibited}

## Icons
- {e.g. Inline SVG, strokeWidth 1.5}
- {e.g. Do not wrap in an icon container (rounded background box)}
