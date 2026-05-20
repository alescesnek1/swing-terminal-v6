const { execSync } = require('child_process');
const opts = { encoding: 'utf8', cwd: __dirname, stdio: 'inherit' };
try {
  execSync('git commit -m "fix: Strip animation traps and hardcode manual DOM visibility"', opts);
  execSync('git push origin main', opts);
  console.log('\\nDONE - committed and pushed.');
} catch (e) {
  console.error('Git failed:', e.message);
  process.exit(1);
}
