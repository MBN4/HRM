/**
 * Design tokens mirroring apps/portal/tailwind.config.ts's palette, so the
 * mobile app reads as the same product as the web portal rather than a
 * default-React-Native-starter look. React Native has no CSS/Tailwind, so
 * these are plain JS objects consumed directly by StyleSheet.create() calls
 * across src/components and src/screens — this is the ONE place a color/
 * spacing/radius value is allowed to be a literal.
 */
export const colors = {
  brand: {
    50: '#effbf6',
    100: '#d7f3e7',
    200: '#b1e7d1',
    300: '#7fd4b6',
    400: '#4bba98',
    500: '#279e7d',
    600: '#1a7f65',
    700: '#176653',
    800: '#155144',
    900: '#124339',
  },
  sand: {
    50: '#faf9f6',
    100: '#f3f0ea',
    200: '#e7e0d3',
    300: '#d5c9b3',
  },
  ink: {
    50: '#f5f6f7',
    100: '#e6e8eb',
    200: '#cfd3d9',
    300: '#a7aeb8',
    400: '#788393',
    500: '#5b6577',
    600: '#454d5c',
    700: '#343a46',
    800: '#22262e',
    900: '#15171c',
  },
  amber: {
    50: '#fdf8ed',
    400: '#eeab2f',
    500: '#d68f1a',
    600: '#b3730f',
  },
  coral: {
    50: '#fdf1ef',
    400: '#e88268',
    500: '#d4644a',
    600: '#b34a34',
  },
  white: '#ffffff',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

export const typography = {
  title: { fontSize: 22, fontWeight: '700' as const },
  heading: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  small: { fontSize: 13, fontWeight: '400' as const },
  label: { fontSize: 12, fontWeight: '600' as const },
};

export const shadow = {
  card: {
    shadowColor: '#0b0c0f',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
};
