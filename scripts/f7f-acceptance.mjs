import { pathToFileURL } from 'node:url';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile, readdir, readFile, copyFile } from 'node:fs/promises';
import { candidateIdentity, runEvidenceCommand } from './lib/f7f-evidence.mjs';
export function acceptanceOptions(args) {
  const modes = args.filter(value => value.startsWith('--mode='));
  if (modes.length !== 1 || modes[0] !== '--mode=synthetic') throw Error('SYNTHETIC_ONLY');
  if (args.some(value => !value.startsWith('--mode=') && !value.startsWith('--evidence-root=')) || args.filter(value => value.startsWith('--evidence-root=')).length > 1) throw Error('ARGUMENT_INVALID');
  const evidenceRoot = args.find(value => value.startsWith('--evidence-root='))?.slice(16) ?? 'local/f7f-acceptance';
  const path = relative(resolve('local'), resolve(evidenceRoot));
  if (!path || path.startsWith('..') || isAbsolute(path)) throw Error('SYNTHETIC_EVIDENCE_ROOT');
  return { mode: 'synthetic', evidenceRoot: resolve(evidenceRoot) };
}
const repo = resolve(import.meta.dirname, '..');
export const acceptanceSelections = [
  { group: 'G1', owner: 'AccessPolicyApiTest', methods: ['workspaceAccessMemberRoleChangeKeepsOwnerGuard','directoryIncludesNoneWithoutGrantingContent'] },
  { group: 'G1', owner: 'AccessEpochLifecycleTest', methods: ['removalAndRejoinKeepMonotonicEpochsAndNeverRestoreMemberAllow'] },
  { group: 'G2', owner: 'ArtifactApiTest', methods: ['publicationSameIntentReturnsOriginalAndOneVersion','publicationStoredCopySurvivesActualSourceRemoval','reportCannotCrossProjectScope'] },
  { group: 'G2', owner: 'ArtifactRetentionTest', methods: ['storageReadDeleteCleanupInterleavingReturnsCompleteOrExplicitReason'] },
  { group: 'G3', owner: 'GrantLifecycleTest', methods: ['responsibilityLossAndRegainNeverRevivesOriginalSecret','actualPolicyTighteningAndLooseningBetweenReadsNeverRevivesSecret','rotationActuallyRejectsOriginalHttpKeyAndDoesNotReplayPlaintext'] },
  { group: 'G4', owner: 'SharedMockApiTest', methods: ['sameSavedRulesProduceTwoRealHttpResponsesAndNoControlHeadersReachNode','realSavedSourcePreviewRejectsForbiddenDependenciesAndExcludedResponseNames'] },
  { group: 'G4', owner: 'SharedMockLifecycleTest', methods: ['killedNodeFailsOldCallWithoutReplayAndNewCallLoadsFixedPlan','realCallerDisconnectCancelsReachedNodeDelay','runtimeCapacityIsAnImmediate429WithoutBackgroundRetry','responseDeadlineCollectsRealTransportBeforeReleasingGatewayOwnership'] },
  { group: 'G4', owner: 'CollaborationAuditTest', methods: ['logAndAuditPermissionsAreIndependentAndMockKeyIsNotManagementAuthority'] },
  { group: 'G5', owner: 'PublicOriginBoundaryTest', methods: ['viewerShellAndItsActualFixedBuildResourcesAreSeparateFromConsole','enabledDownloadMetadataMatchesIndependentlyAuthorizedSafeJsonTransport','originMustBeSeparateAndHttpsForRemoteDeployment'] },
];
const quotePowerShell = value => `'${value.replaceAll("'", "''")}'`;
export async function runAcceptance(options) {
  // Finish all prerequisites before the first owned resource/evidence allocation.
  const java = join(process.env.JAVA_HOME ?? '', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const javaProbe = spawnSync(java, ['-version'], { encoding: 'utf8', windowsHide: true });
  if (javaProbe.status !== 0 || !/version "21\./.test(javaProbe.stderr ?? '')) throw Error('PREREQUISITE_JAVA21');
  if (process.version !== 'v22.19.0') throw Error('PREREQUISITE_NODE_22_19_0');
  const pnpmEntry = process.env.APICC_PNPM_CLI;
  if (!pnpmEntry) throw Error('PREREQUISITE_APICC_PNPM_CLI');
  const pnpmProbe = spawnSync(process.execPath, [pnpmEntry, '--version'], { encoding: 'utf8', windowsHide: true });
  if (pnpmProbe.status !== 0 || pnpmProbe.stdout.trim() !== '11.21.0') throw Error('PREREQUISITE_PNPM_11_21_0');
  for (const file of ['packages/core/dist/collaboration/index.js','packages/execution/dist/client/collaboration.js','apps/collaboration-runtime/dist/main.js','apps/runner-agent/dist/main.js','apps/desktop/dist-electron/main/online/collaboration.js',...['index.html','viewer.js','viewer.css'].map(name => `apps/share-viewer/dist/${name}`)]) {
    try { await access(join(repo, file)); } catch { throw Error(`PREREQUISITE_BUILD_REQUIRED: ${file}`); }
  }
  const before = await candidateIdentity(repo);
  const engine = spawnSync('docker', ['info','--format','{{.OSType}}'], {encoding:'utf8',windowsHide:true});
  if(engine.status!==0||engine.stdout.trim()!=='linux')throw Error('PREREQUISITE_LINUX_DOCKER');
  await mkdir(options.evidenceRoot, { recursive: true });
  const root = await mkdtemp(join(options.evidenceRoot, 'run-'));
  const result = { mode: 'synthetic', root, before, after: null, passed: false, groups: [], commands: [], cleanup: [], pending: ['actual bilingual native/browser/CSP/two-origin visual acceptance','unique task and whole-branch review','controller-owned final scripts/test-all.ps1'], limitations: ['Selected existing authority fixtures are reused; no full role/endpoint matrix or soak. Required UI gates remain unproven until actual review.'] };
  const save = () => writeFile(join(root, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
  const execute = async (label, command, args, timeoutMs = 300000, env = process.env) => {
    const value = await runEvidenceCommand({ command, args, cwd: repo, timeoutMs, env, logFile: join(root, label + '.log') });
    const { stdout, stderr, ...facts } = value; result.commands.push({ label, ...facts }); result.cleanup.push({ label, pid: value.pid, collected: value.collected, cleanupError: value.cleanupError ?? null }); await save();
    if (!value.passed) throw Error(`${label.toUpperCase()}_FAILED: exit=${value.exitCode} timeout=${value.timedOut}; see ${root}`);
    return value;
  };
  console.log(`F7F_SYNTHETIC_EVIDENCE ${root}`);
  try {
    await execute('strict-boundary', process.execPath, ['apps/collaboration-runtime/scripts/generate-java-boundary.mjs','--check']);
    const build = join(root, 'maven'), xmlRoot = join(root, 'owning-xml'); await mkdir(xmlRoot);
    const selector = acceptanceSelections.map(row => `${row.owner}#${row.methods.join('+')}`).join(',');
    const mavenArgs = ['-s', join(repo, 'server/.mvn/settings.xml'), '-f', join(repo, 'server/pom.xml'), `-Dapicc.build.directory=${build}`, `-Dtest=${selector}`, 'package'];
    let javaFailure;
    try {
      const wrapper = join(repo, 'server', process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
      if (process.platform === 'win32') await execute('java-authorities', 'powershell.exe', ['-NoProfile','-NonInteractive','-Command', `& ${[wrapper,...mavenArgs].map(quotePowerShell).join(' ')}; exit $LASTEXITCODE`], 600000, { ...process.env, APICC_TEST_NODE: process.execPath });
      else await execute('java-authorities', wrapper, mavenArgs, 600000, { ...process.env, APICC_TEST_NODE: process.execPath });
    } catch (error) { javaFailure = error; }
    // Immediately retain only this command's owning XML; no stale shared target directory.
    for (const selected of acceptanceSelections) {
      const directory = join(build, 'surefire-reports');
      const filename = (await readdir(directory)).find(name => name.startsWith('TEST-') && name.endsWith(`.${selected.owner}.xml`));
      if (!filename) throw Error(`JAVA_REQUIRED_TEST_NOT_RUN: ${selected.owner}`);
      await copyFile(join(directory, filename), join(xmlRoot, filename));
      const xml = await readFile(join(xmlRoot, filename), 'utf8'), header = xml.match(/<testsuite\s[^>]+>/)?.[0] ?? '';
      const count = name => Number(header.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? NaN);
      if (!Number.isFinite(count('tests')) || count('tests') < selected.methods.length || count('failures') || count('errors') || count('skipped')) throw Error(`JAVA_REQUIRED_TEST_FAILED_OR_SKIPPED: ${selected.owner}`);
      for (const method of selected.methods) if (!xml.includes(`name="${method}`)) throw Error(`JAVA_REQUIRED_METHOD_NOT_RUN: ${selected.owner}#${method}`);
      result.groups.push({ group: selected.group, owner: selected.owner, tests: count('tests'), failures: count('failures'), errors: count('errors'), skipped: count('skipped'), xml: join(xmlRoot, filename) });
    }
    if (javaFailure) throw javaFailure;
    const jar = (await readdir(build)).find(name => /^apicc-server-.+\.jar$/.test(name)); if (!jar) throw Error('JAVA_PACKAGE_REQUIRED');
    await execute('agent-composition', process.execPath, [pnpmEntry,'-C','apps/runner-agent','exec','vitest','run','tests/f7f-acceptance.test.ts','--maxWorkers=2','--reporter=junit',`--outputFile=${join(root,'agent-junit.xml')}`], 600000, { ...process.env, APICC_F7F_EVIDENCE_ROOT: root, APICC_F7F_JAR: join(build, jar) });
    const junit = await readFile(join(root, 'agent-junit.xml'), 'utf8');
    if (!/tests="1"/.test(junit) || /(?:failures|errors|skipped)="[1-9]/.test(junit)) throw Error('AGENT_REQUIRED_SCENARIO_NOT_PROVEN');
    result.groups.push({ group: 'G2/G4/G5', owner: 'real Java/Node/agent composition', tests: 1, skipped: 0, xml: join(root, 'agent-junit.xml') });
    await execute('container-resources',process.execPath,['scripts/smoke-collaboration.mjs',root],600000);
    result.groups.push({group:'G5/AC14',owner:'real private containers and Java-only/optional runtime startup',evidenceRoot:root});
    result.after = await candidateIdentity(repo);
    if (before.sourceSha256 !== result.after.sourceSha256 || before.indexSha256 !== result.after.indexSha256 || JSON.stringify(before.packages) !== JSON.stringify(result.after.packages)) throw Error('CANDIDATE_CHANGED_DURING_ACCEPTANCE');
    result.passed = true;
    console.log('F7F_SYNTHETIC_AUTOMATED_GROUPS_PASSED; UI/review/final-rootgate remain pending');
  } catch (error) { result.failure = error.message; console.error(error.message); }
  finally { result.after ??= await candidateIdentity(repo); await save(); }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result = await runAcceptance(acceptanceOptions(process.argv.slice(2))); process.exitCode = result.passed ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
