// PR titles become squash commits, so they follow the commit header rules.
// A title has no body, so only the header rules apply here.
import config from './commitlint.config.mjs';

export default {
  ...config,
  rules: { ...config.rules, 'body-empty': [0] },
};
