/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#2D9CDB',
          light: '#56CCF2',
          lighter: '#A8E6F8',
        },
        secondary: {
          DEFAULT: '#27AE60',
          light: '#6EE7B7',
        },
        surface: {
          DEFAULT: '#FFFFFF',
          secondary: '#F3F4F6',
          tertiary: '#E5E7EB',
        },
        text: {
          primary: '#0F1724',
          secondary: '#4B5563',
          tertiary: '#7A8393',
          muted: '#9CA3AF',
        },
      },
      spacing: {
        'safe-top': 'env(safe-area-inset-top)',
        'safe-bottom': 'env(safe-area-inset-bottom)',
        'safe-left': 'env(safe-area-inset-left)',
        'safe-right': 'env(safe-area-inset-right)',
      },
      fontFamily: {
        sans: ['Segoe UI', 'system-ui', 'Avenir', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

