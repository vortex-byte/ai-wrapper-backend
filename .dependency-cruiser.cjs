/**
 * dependency-cruiser rule set.
 *
 * The import direction is:
 *   http ──► application ──► domain
 *                 │
 *                 └──► ports ◄── infrastructure
 *   domain ──► (nothing)
 *
 * Separation rules:
 *   provider adapters must not know db/ ; storage/ must not know conversations/ ;
 *   attachments/ must not know providers/.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make the module graph un-orderable.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'domain/ holds pure rules only: no infrastructure, http, db, node:*, or third-party SDKs.',
      from: { path: '(^|/)domain/' },
      to: {
        path: [
          '(^|/)(infrastructure|http)/',
          '(^|/)db/',
          '^node:',
          'node_modules/(drizzle-orm|pg|postgres|hono|pino|@hono/)',
        ],
      },
    },
    {
      name: 'http-no-infrastructure',
      severity: 'error',
      comment: 'Routes call use cases; they never reach into infrastructure directly.',
      from: { path: '(^|/)http/' },
      to: { path: '(^|/)infrastructure/' },
    },
    {
      name: 'application-no-http',
      severity: 'error',
      comment: 'Use cases must not depend on HTTP.',
      from: { path: '(^|/)application/' },
      to: { path: '(^|/)http/' },
    },
    {
      name: 'providers-no-db',
      severity: 'error',
      comment:
        'Provider adapters (and provider domain rules) know no database tables. ' +
        'The registry\'s own persistence lives in providers/infrastructure/drizzle-* and its ports take ' +
        'the Unit-of-Work handle, exactly like every other feature module.',
      from: { path: '(^|/)providers/(domain/|infrastructure/adapters/|infrastructure/fake/)' },
      to: { path: '(^|/)db/' },
    },
    {
      name: 'storage-no-conversations',
      severity: 'error',
      comment: 'Storage knows no conversations.',
      from: { path: '(^|/)storage/' },
      to: { path: '(^|/)conversations/' },
    },
    {
      name: 'attachments-no-providers',
      severity: 'error',
      comment: 'Attachment intake knows no providers.',
      from: { path: '(^|/)attachments/' },
      to: { path: '(^|/)providers/' },
    },
    {
      name: 'no-provider-sdk-outside-providers',
      severity: 'error',
      comment: 'Only src/providers/ may import a provider SDK.',
      from: { pathNot: '(^|/)providers/' },
      to: {
        path: 'node_modules/(openai|@anthropic-ai|@google/generative-ai|@google/genai|cohere-ai|@mistralai)/',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|coverage)/' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports', 'imports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
