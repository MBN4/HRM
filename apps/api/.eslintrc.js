module.exports = {
  root: true,
  extends: [require.resolve('@hrm/config/eslint-preset.js')],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  overrides: [
    {
      files: ['*.js'],
      parserOptions: {
        project: null,
      },
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
  ],
};
