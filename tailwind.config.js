/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,tsx,ts}'],
  theme: {
    extend: {
      colors: {
        'session-running': '#22c55e',
        'session-waiting': '#eab308',
        'session-idle': '#6b7280',
        'session-error': '#ef4444',
      }
    }
  },
  plugins: []
}
