module.exports = {
  extends: [require.resolve('@hrm/config/eslint-preset.js')],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
};
