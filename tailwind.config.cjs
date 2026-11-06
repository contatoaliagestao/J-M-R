/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/index.html', './public/app.js'],
  theme: {
    extend: {
      // Tons de "slate" um pouco mais claros que o padrão do Tailwind (fundo menos escuro)
      colors: {
        slate: {
          500: '#7c8aa0', 600: '#5b6b84', 700: '#3d4c67', 800: '#2b3953', 850: '#24314a', 900: '#1d2840', 950: '#152036',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
};
