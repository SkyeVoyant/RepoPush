#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const os = require('os');

const execFileAsync = util.promisify(execFile);

// Parse .env file (reads fresh every time)
function parseEnvFile(envPath) {
  const content = fs.readFileSync(envPath, 'utf8');
  const config = {
    token: null,
    syncTime: 60, // default 60 minutes
    projects: []
  };

  const lines = content.split('\n');
  let currentProject = null;

  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Parse key = value
    const match = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (!match) continue;

    const key = match[1].trim();
    const value = match[2].trim();

    if (key === 'token') {
      config.token = value;
    } else if (key === 'sync_time') {
      config.syncTime = parseInt(value, 10) || 60;
    } else if (key === 'gitlink') {
      if (currentProject) {
        // Finish previous project if it has both fields
        if (currentProject.gitlink && currentProject.gitlocation) {
          config.projects.push(currentProject);
        }
      }
      currentProject = { gitlink: value, gitlocation: null };
    } else if (key === 'gitlocation') {
      if (currentProject) {
        currentProject.gitlocation = value;
      }
    }
  }

  // Add last project if it's complete
  if (currentProject && currentProject.gitlink && currentProject.gitlocation) {
    config.projects.push(currentProject);
  }

  return config;
}

// Get .env file path
function getEnvPath() {
  return process.env.ENV_FILE || path.join(__dirname, '.env');
}

// Create askpass script for git authentication
function createAskPassScript(token) {
  const scriptPath = path.join(os.tmpdir(), `github-askpass-${Date.now()}.sh`);
  const script = `#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *) echo "${token}" ;;
esac
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  return scriptPath;
}

// Execute git command with timeout
async function git(projectPath, args, options = {}) {
  const timeout = options.timeout || 300000; // 5 minutes default timeout
  const timeoutMs = timeout;
  delete options.timeout; // Remove timeout from options before passing to execFile
  
  return new Promise((resolve, reject) => {
    let resolved = false;
    const child = execFile('git', args, {
      cwd: projectPath,
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large repos
      ...options
    }, (error, stdout, stderr) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      
      if (error) {
        const stderrMsg = (stderr || '').toString().trim();
        const message = stderrMsg || error.message;
        reject(new Error(message));
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });

    // Set timeout - kill more aggressively
    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill('SIGKILL'); // Use SIGKILL for immediate termination
      } catch (e) {
        // Ignore
      }
      reject(new Error(`Git command timed out after ${timeoutMs}ms: git ${args.join(' ')}`));
    }, timeoutMs);
  });
}

// Check if directory is a git repository
async function isGitRepo(projectPath) {
  try {
    await git(projectPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

// Get current branch
async function getCurrentBranch(projectPath) {
  try {
    const { stdout } = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout || 'main';
  } catch {
    return 'main';
  }
}

// Get all local branches
async function getAllBranches(projectPath) {
  try {
    const { stdout } = await git(projectPath, ['branch', '--list', '--format', '%(refname:short)']);
    return stdout.split('\n').filter(b => b.trim()).map(b => b.trim());
  } catch {
    return [];
  }
}

// Get all tags
async function getAllTags(projectPath) {
  try {
    const { stdout } = await git(projectPath, ['tag', '--list']);
    return stdout.split('\n').filter(t => t.trim()).map(t => t.trim());
  } catch {
    return [];
  }
}

// Check if remote branch exists
async function remoteBranchExists(projectPath, branch, remote = 'github') {
  try {
    await git(projectPath, ['ls-remote', '--heads', remote, branch], {
      timeout: 15000 // 15 second timeout (shorter for faster checks)
    });
    return true;
  } catch (error) {
    if (error.message.includes('timed out')) {
      // Timeout means we can't verify, assume it doesn't exist to trigger sync
      return false;
    }
    return false;
  }
}

// Get local commit hash for a branch
async function getLocalCommitHash(projectPath, branch) {
  try {
    const { stdout } = await git(projectPath, ['rev-parse', branch]);
    return stdout.trim();
  } catch {
    return null;
  }
}

// Get remote commit hash for a branch
async function getRemoteCommitHash(projectPath, branch, remote = 'github') {
  try {
    const { stdout } = await git(projectPath, ['ls-remote', '--heads', remote, branch], {
      timeout: 15000 // 15 second timeout (shorter for faster checks)
    });
    if (stdout.trim()) {
      // Format: <hash>	refs/heads/<branch>
      const match = stdout.trim().match(/^([a-f0-9]+)\s+refs\/heads\//);
      return match ? match[1] : null;
    }
    return null;
  } catch (error) {
    if (error.message.includes('timed out')) {
      // Timeout means we can't verify, return null to trigger sync
      return null;
    }
    return null;
  }
}

// Check if branch needs syncing (local is ahead of remote)
async function branchNeedsSync(projectPath, branch, remote = 'github') {
  try {
    const remoteExists = await remoteBranchExists(projectPath, branch, remote);
    
    if (!remoteExists) {
      // Remote doesn't exist, need to push
      return true;
    }

    const localHash = await getLocalCommitHash(projectPath, branch);
    const remoteHash = await getRemoteCommitHash(projectPath, branch, remote);

    if (!localHash) {
      return false; // Can't determine, skip
    }

    if (!remoteHash) {
      return true; // Remote doesn't have this branch, need to push
    }

    if (localHash === remoteHash) {
      return false; // Already in sync
    }

    // Check if local is ahead (has commits not in remote)
    try {
      const { stdout } = await git(projectPath, ['rev-list', '--count', `${remoteHash}..${localHash}`], {
        timeout: 10000
      });
      const aheadCount = parseInt(stdout.trim(), 10) || 0;
      return aheadCount > 0;
    } catch {
      // If we can't compare, assume we need to sync (might be diverged)
      return true;
    }
  } catch (error) {
    // On error, assume we need to sync to be safe
    console.log(`[${path.basename(projectPath)}] Could not check sync status for ${branch}, will attempt sync: ${error.message}`);
    return true;
  }
}

// Check if tags need syncing
async function tagsNeedSync(projectPath, remote = 'github') {
  try {
    const localTags = await getAllTags(projectPath);
    if (localTags.length === 0) {
      return false;
    }

    // Get remote tags
    let remoteTags = [];
    try {
      const { stdout } = await git(projectPath, ['ls-remote', '--tags', remote], {
        timeout: 15000 // 15 second timeout
      });
      remoteTags = stdout.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const match = line.match(/refs\/tags\/([^\s\^]+)/);
          return match ? match[1] : null;
        })
        .filter(tag => tag !== null);
    } catch (error) {
      // If we can't fetch remote tags (including timeout), assume we need to sync
      if (error.message.includes('timed out')) {
        return true; // Timeout - assume we need to sync to be safe
      }
      return true;
    }

    // Check if any local tags are missing on remote
    for (const localTag of localTags) {
      if (!remoteTags.includes(localTag)) {
        return true; // Found a tag that needs syncing
      }
    }

    return false; // All tags are synced
  } catch {
    return true; // On error, assume we need to sync
  }
}

// Set remote URL with token
async function setRemote(projectPath, gitlink, token) {
  // Convert HTTPS URL to include token
  // For fine-grained tokens, use x-access-token as username
  // https://github.com/user/repo -> https://x-access-token:token@github.com/user/repo
  let remoteUrl = gitlink;
  if (remoteUrl.startsWith('https://')) {
    // Remove existing auth if present
    remoteUrl = remoteUrl.replace(/https:\/\/[^@]+@/, 'https://');
    // Insert token with x-access-token username
    remoteUrl = remoteUrl.replace('https://', `https://x-access-token:${token}@`);
  } else if (remoteUrl.startsWith('git@')) {
    // For SSH, convert to HTTPS with token
    remoteUrl = remoteUrl
      .replace('git@github.com:', 'https://')
      .replace('.git', '')
      .replace('https://', `https://x-access-token:${token}@`) + '.git';
  }

  // Check if remote exists
  let remoteExists = false;
  try {
    await git(projectPath, ['remote', 'get-url', 'github']);
    remoteExists = true;
  } catch {
    remoteExists = false;
  }

  if (remoteExists) {
    // Update existing remote URL
    await git(projectPath, ['remote', 'set-url', 'github', remoteUrl]);
  } else {
    // Add new remote
    await git(projectPath, ['remote', 'add', 'github', remoteUrl]);
  }
}

// Sync a single project
async function syncProject(project, token) {
  const { gitlink, gitlocation } = project;
  const projectName = path.basename(gitlocation);

  console.log(`\n[${projectName}] Starting sync...`);
  console.log(`  Location: ${gitlocation}`);
  console.log(`  Remote: ${gitlink}`);

  // Check if directory exists
  if (!fs.existsSync(gitlocation)) {
    console.error(`[${projectName}] ERROR: Directory does not exist: ${gitlocation}`);
    return;
  }

  // Check if it's a git repo
  const isRepo = await isGitRepo(gitlocation);
  if (!isRepo) {
    console.error(`[${projectName}] ERROR: Not a git repository: ${gitlocation}`);
    return;
  }

  try {
    // Set remote
    await setRemote(gitlocation, gitlink, token);

    // Get current branch (don't modify local repo structure)
    const currentBranch = await getCurrentBranch(gitlocation);
    const targetBranch = 'main'; // Always push to main on GitHub
    console.log(`[${projectName}] Current local branch: ${currentBranch}`);
    console.log(`[${projectName}] Syncing to ${targetBranch} on GitHub (no local changes)`);

    // Check if main branch on GitHub needs syncing
    // We check against the remote main branch, but we'll push from current local branch
    const needsSync = await branchNeedsSync(gitlocation, targetBranch, 'github');
    
    if (!needsSync) {
      console.log(`[${projectName}] GitHub ${targetBranch} branch is already in sync, skipping`);
      return;
    }

    // Push current branch to main on GitHub (will create main on GitHub if it doesn't exist)
    // Format: git push github <local-branch>:main
    console.log(`[${projectName}] GitHub ${targetBranch} needs sync, pushing ${currentBranch} -> ${targetBranch}...`);
    try {
      // Push current branch to main on GitHub with set-upstream (creates main on GitHub if it doesn't exist)
      await git(gitlocation, ['push', '--set-upstream', 'github', `${currentBranch}:${targetBranch}`, '--force'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '30' },
        timeout: 120000 // 2 minute timeout for push
      });
      console.log(`[${projectName}] ✓ Pushed ${currentBranch} -> ${targetBranch} on GitHub`);
    } catch (error) {
      // If set-upstream fails, try regular push
      try {
        await git(gitlocation, ['push', 'github', `${currentBranch}:${targetBranch}`, '--force'], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '30' },
          timeout: 120000
        });
        console.log(`[${projectName}] ✓ Pushed ${currentBranch} -> ${targetBranch} on GitHub`);
      } catch (error2) {
        // Check if it's a permission error
        const errorMsg = error2.message.toLowerCase();
        if (errorMsg.includes('permission') || errorMsg.includes('forbidden') || errorMsg.includes('unauthorized')) {
          console.error(`[${projectName}] ✗ Permission denied. To create branches, the token needs:`);
          console.error(`[${projectName}]    - Contents: Read and write (required)`);
          console.error(`[${projectName}]    - Metadata: Read (may be needed to verify repository access)`);
          console.error(`[${projectName}]   If it still fails, you may also need:`);
          console.error(`[${projectName}]    - Administration: Read (if repository settings restrict branch creation)`);
        }
        console.error(`[${projectName}] ✗ Failed to push ${currentBranch} -> ${targetBranch}: ${error2.message}`);
      }
    }

    // Push tags if needed
    const tagsNeedPushing = await tagsNeedSync(gitlocation, 'github');
    if (tagsNeedPushing) {
      const tags = await getAllTags(gitlocation);
      if (tags.length > 0) {
        console.log(`[${projectName}] Found ${tags.length} tag(s) that need syncing`);
        try {
          await git(gitlocation, ['push', 'github', '--tags', '--force'], {
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            timeout: 120000
          });
          console.log(`[${projectName}] ✓ Pushed all tags`);
        } catch (error) {
          console.error(`[${projectName}] ✗ Failed to push tags: ${error.message}`);
        }
      }
    } else {
      const tags = await getAllTags(gitlocation);
      if (tags.length > 0) {
        console.log(`[${projectName}] All tags are already in sync (${tags.length} tag(s))`);
      }
    }

    console.log(`[${projectName}] Sync complete`);

  } catch (error) {
    console.error(`[${projectName}] ERROR: ${error.message}`);
  }
}

// Perform full sync of all projects
async function performSync() {
  const envPath = getEnvPath();
  
  if (!fs.existsSync(envPath)) {
    console.error(`ERROR: .env file not found at ${envPath}`);
    return;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Reading configuration from: ${envPath}`);
  console.log(`${'='.repeat(60)}`);

  // Read .env file fresh
  const config = parseEnvFile(envPath);

  if (!config.token) {
    console.error('ERROR: GitHub token not found in .env file');
    return;
  }

  if (config.projects.length === 0) {
    console.log('No projects configured in .env file');
    return;
  }

  console.log(`Token: ${config.token.substring(0, 8)}...`);
  console.log(`Sync interval: ${config.syncTime} minutes`);
  console.log(`Projects to sync: ${config.projects.length}`);

  // Sync each project
  for (const project of config.projects) {
    await syncProject(project, config.token);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('All projects synced');
  console.log(`${'='.repeat(60)}\n`);
}

// Main function
async function main() {
  console.log('=== RepoPush ===');
  console.log('Starting sync service...\n');

  // Perform initial sync
  await performSync();

  // Read sync interval from .env
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) {
    console.error(`ERROR: .env file not found at ${envPath}`);
    process.exit(1);
  }

  const config = parseEnvFile(envPath);
  const syncIntervalMs = (config.syncTime || 60) * 60 * 1000;

  console.log(`\nScheduling syncs every ${config.syncTime} minutes`);
  console.log('Press Ctrl+C to stop\n');

  // Schedule periodic syncs
  const intervalId = setInterval(async () => {
    await performSync();
  }, syncIntervalMs);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    clearInterval(intervalId);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n\nShutting down...');
    clearInterval(intervalId);
    process.exit(0);
  });
}

// Run main
main().catch(error => {
  console.error(`FATAL: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});

