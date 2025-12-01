#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const chokidar = require('chokidar');
const ignore = require('ignore');

// Parse .env file (reads fresh every time for push config)
function parseEnvFile(envPath) {
  const content = fs.readFileSync(envPath, 'utf8');
  const config = {
    token: null,
    gitAuthorName: null,
    gitAuthorEmail: null,
    syncTime: 60, // default 60 minutes
    commitDebounceMs: 3000, // default 3 seconds debounce for commits
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
    } else if (key === 'git_author_name') {
      config.gitAuthorName = value;
    } else if (key === 'git_author_email') {
      config.gitAuthorEmail = value;
    } else if (key === 'sync_time') {
      config.syncTime = parseInt(value, 10) || 60;
    } else if (key === 'commit_debounce_ms') {
      config.commitDebounceMs = parseInt(value, 10) || 3000;
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

// Execute git command with streaming (discards output when not needed)
async function git(projectPath, args, options = {}) {
  const timeout = options.timeout || 300000; // 5 minutes default timeout
  const timeoutMs = timeout;
  const discardOutput = options.discardOutput !== false; // Default to discarding
  const maxOutputSize = options.maxOutputSize || 1024; // 1KB default for commands that need output
  
  // Extract custom options and preserve spawn options
  const { timeout: _, discardOutput: __, maxOutputSize: ___, env, ...spawnOptions } = options;
  
  return new Promise((resolve, reject) => {
    let resolved = false;
    let stdout = '';
    let stderr = '';
    let stdoutSize = 0;
    let stderrSize = 0;
    
    const child = spawn('git', args, {
      cwd: projectPath,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions
    });

    // Discard or collect stdout
    if (discardOutput) {
      child.stdout.on('data', () => {
        // Discard all output
      });
    } else {
      child.stdout.on('data', (chunk) => {
        if (stdoutSize < maxOutputSize) {
          stdout += chunk.toString();
          stdoutSize += chunk.length;
        }
      });
    }

    // Collect stderr for error messages (limited size)
    child.stderr.on('data', (chunk) => {
      if (stderrSize < 1024) { // Max 1KB for error messages
        stderr += chunk.toString();
        stderrSize += chunk.length;
      }
    });

    child.on('error', (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      cleanup();
      // Error event is for process startup failures (e.g., git not found)
      reject(error);
    });

    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      
      // Capture values before cleanup
      const stdoutResult = stdout.trim();
      const stderrResult = stderr.trim();
      
      cleanup();
      
      if (code !== 0) {
        const message = stderrResult || `Git command failed with code ${code}`;
        reject(new Error(message));
      } else {
        resolve({ stdout: stdoutResult, stderr: stderrResult });
      }
    });

    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch (e) {
        // Ignore
      }
      reject(new Error(`Git command timed out after ${timeoutMs}ms: git ${args.join(' ')}`));
    }, timeoutMs);

    function cleanup() {
      // Explicitly clean up streams and references
      if (child.stdout) {
        child.stdout.removeAllListeners();
        child.stdout.destroy();
      }
      if (child.stderr) {
        child.stderr.removeAllListeners();
        child.stderr.destroy();
      }
      if (child.stdin) {
        child.stdin.removeAllListeners();
        child.stdin.destroy();
      }
      // Clear string references to help GC
      stdout = null;
      stderr = null;
    }
  });
}

// Fetch GitHub user info
async function fetchGitHubUserInfo(token) {
  try {
    const response = await axios.get('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    return {
      name: response.data.name || response.data.login,
      email: response.data.email || `${response.data.id}+${response.data.login}@users.noreply.github.com`,
      login: response.data.login
    };
  } catch (error) {
    console.error('Failed to fetch GitHub user info:', error.message);
    return null;
  }
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
    const { stdout } = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      discardOutput: false,
      maxOutputSize: 256 // Branch names are short
    });
    return stdout || 'main';
  } catch {
    return 'main';
  }
}

// Load .gitignore patterns for a project
function loadGitignorePatterns(projectPath) {
  const ig = ignore();
  
  // Add default ignores
  ig.add([
    '.git',
    '.git/**',
    'node_modules',
    'node_modules/**'
  ]);

  // Load .gitignore if it exists
  const gitignorePath = path.join(projectPath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      ig.add(content);
    } catch (error) {
      console.error(`Failed to read .gitignore: ${error.message}`);
    }
  }

  return ig;
}

// Check if path should be ignored
function shouldIgnorePath(projectPath, filePath, igInstance) {
  const relative = path.relative(projectPath, filePath);
  
  // Ignore if outside project
  if (!relative || relative.startsWith('..')) {
    return true;
  }
  
  // Check against ignore patterns
  return igInstance.ignores(relative);
}

// Check if there are uncommitted changes
async function hasUncommittedChanges(projectPath) {
  try {
    const { stdout } = await git(projectPath, ['status', '--porcelain'], {
      discardOutput: false,
      maxOutputSize: 1024 // Only need to check if empty
    });
    return stdout.length > 0;
  } catch {
    return false;
  }
}

// Set remote URL with token
async function setRemote(projectPath, gitlink, token) {
  let remoteUrl = gitlink;
  if (remoteUrl.startsWith('https://')) {
    remoteUrl = remoteUrl.replace(/https:\/\/[^@]+@/, 'https://');
    remoteUrl = remoteUrl.replace('https://', `https://x-access-token:${token}@`);
  } else if (remoteUrl.startsWith('git@')) {
    remoteUrl = remoteUrl
      .replace('git@github.com:', 'https://github.com/')
      .replace('.git', '')
      .replace('https://', `https://x-access-token:${token}@`) + '.git';
  }

  let remoteExists = false;
  try {
    await git(projectPath, ['remote', 'get-url', 'github']);
    remoteExists = true;
  } catch {
    remoteExists = false;
  }

  if (remoteExists) {
    await git(projectPath, ['remote', 'set-url', 'github', remoteUrl]);
  } else {
    await git(projectPath, ['remote', 'add', 'github', remoteUrl]);
  }
}

// Set git user config
async function setGitConfig(projectPath, userInfo) {
  await git(projectPath, ['config', 'user.name', userInfo.name]);
  await git(projectPath, ['config', 'user.email', userInfo.email]);
  await git(projectPath, ['config', 'commit.gpgsign', 'false']);
}

// Commit changes in a project
async function commitChanges(projectPath, userInfo) {
  const projectName = path.basename(projectPath);
  
  try {
    // Check if there are changes
    const hasChanges = await hasUncommittedChanges(projectPath);
    if (!hasChanges) {
      return false;
    }

    // Stage all changes
    await git(projectPath, ['add', '-A']);

    // Check again after staging
    const hasChangesAfterStaging = await hasUncommittedChanges(projectPath);
    if (!hasChangesAfterStaging) {
      return false;
    }

    // Set git config
    await setGitConfig(projectPath, userInfo);

    // Commit
    const timestamp = new Date().toISOString();
    await git(projectPath, ['commit', '-m', `Auto backup ${timestamp}`]);
    console.log(`[${projectName}] ✓ Committed changes`);
    return true;
  } catch (error) {
    console.error(`[${projectName}] Failed to commit: ${error.message}`);
    return false;
  }
}

// Extract repo owner and name from GitHub URL
function parseGitHubUrl(gitlink) {
  // Handle https://github.com/owner/repo or https://github.com/owner/repo.git
  const match = gitlink.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

// Check if GitHub repo exists and create if it doesn't
async function ensureGitHubRepo(gitlink, token, userInfo) {
  const parsed = parseGitHubUrl(gitlink);
  if (!parsed) {
    console.error(`Failed to parse GitHub URL: ${gitlink}`);
    return { exists: false, canRetry: false };
  }

  const { owner, repo } = parsed;

  try {
    // Check if repo exists
    await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    return { exists: true, canRetry: false }; // Repo exists
  } catch (error) {
    if (error.response && error.response.status === 404) {
      // Repo doesn't exist, try to create it
      console.log(`[${repo}] Repository doesn't exist, attempting to create...`);
      
      try {
        // Check if we're creating in user's account or an org
        const isUserRepo = owner === userInfo.login;
        const endpoint = isUserRepo 
          ? 'https://api.github.com/user/repos'
          : `https://api.github.com/orgs/${owner}/repos`;

        await axios.post(endpoint, {
          name: repo,
          private: true,
          auto_init: false,
          description: `Auto-synced repository managed by RepoPush`
        }, {
          headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        });
        
        console.log(`[${repo}] ✓ Created private repository on GitHub`);
        return { exists: true, canRetry: false };
      } catch (createError) {
        // Creation failed - could be permissions or other issues
        const isPermissionError = createError.response && 
          (createError.response.status === 403 || createError.response.status === 401);
        
        if (createError.response) {
          if (isPermissionError) {
            // Permission error - provide helpful info but allow retry
            console.warn(`[${repo}] ⚠ Cannot auto-create repository (missing Administration permission)`);
            console.warn(`[${repo}]   Option 1: Add 'Administration: Read and write' permission to your token`);
            console.warn(`[${repo}]   Option 2: Manually create the repository at: https://github.com/${owner}/${repo}`);
            console.warn(`[${repo}]   Will retry on next sync interval...`);
          } else {
            console.error(`[${repo}] ✗ Failed to create repository: ${createError.response.data.message}`);
          }
        } else {
          console.error(`[${repo}] ✗ Failed to create repository: ${createError.message}`);
        }
        
        // Return canRetry=true so we keep trying
        return { exists: false, canRetry: true };
      }
    } else {
      // Other error checking repo (network, auth, etc)
      console.error(`[${repo}] Failed to check repository: ${error.message}`);
      return { exists: false, canRetry: true };
    }
  }
}

// Push changes to GitHub
async function pushToGitHub(projectPath, gitlink, token, userInfo) {
  const projectName = path.basename(projectPath);
  
  try {
    // Ensure GitHub repo exists (create if needed)
    const repoStatus = await ensureGitHubRepo(gitlink, token, userInfo);
    
    if (!repoStatus.exists) {
      if (repoStatus.canRetry) {
        // Repo doesn't exist but we can retry later (e.g., missing permissions or waiting for manual creation)
        console.log(`[${projectName}] Skipping push - will retry on next sync interval`);
      } else {
        // Something is fundamentally wrong (e.g., invalid URL)
        console.error(`[${projectName}] Skipping push - repository configuration error`);
      }
      return false;
    }

    // Set remote
    await setRemote(projectPath, gitlink, token);

    // Get current branch
    const currentBranch = await getCurrentBranch(projectPath);
    const targetBranch = 'main';

    // Push to GitHub
    console.log(`[${projectName}] Pushing ${currentBranch} -> ${targetBranch} on GitHub...`);
    try {
      await git(projectPath, ['push', '--set-upstream', 'github', `${currentBranch}:${targetBranch}`, '--force'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 120000
      });
      console.log(`[${projectName}] ✓ Pushed to GitHub`);
    } catch (error) {
      // Try without set-upstream
      await git(projectPath, ['push', 'github', `${currentBranch}:${targetBranch}`, '--force'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 120000
      });
      console.log(`[${projectName}] ✓ Pushed to GitHub`);
    }

    // Push tags
    try {
      await git(projectPath, ['push', 'github', '--tags', '--force'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 120000
      });
    } catch (error) {
      // Tags push failure is not critical
    }

    return true;
  } catch (error) {
    console.error(`[${projectName}] Failed to push: ${error.message}`);
    return false;
  }
}

// Project state manager
class ProjectManager {
  constructor(token, userInfo) {
    this.token = token;
    this.userInfo = userInfo;
    this.projects = new Map(); // path -> { gitlink, watcher, commitTimeout, ignoreInstance }
    this.commitDebounceMs = 3000;
  }

  async addProject(gitlink, gitlocation) {
    const projectName = path.basename(gitlocation);

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

    // Load .gitignore patterns
    const ignoreInstance = loadGitignorePatterns(gitlocation);

    // Create file watcher
    const watcher = chokidar.watch(gitlocation, {
      persistent: true,
      ignoreInitial: true,
      ignored: [
        /(^|[\/\\])\../, // dot files/folders
        /node_modules/,
        /dist/,
        /build/,
        /logs/,
        /tmp/,
        /cache/,
        /coverage/,
        /\.log$/,
        /\.tmp$/
      ],
      depth: 99,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      }
    });

    watcher.on('all', (event, filePath) => {
      this.handleFileChange(gitlocation, filePath, ignoreInstance);
    });

    watcher.on('ready', () => {
      console.log(`[${projectName}] File watcher active`);
    });

    watcher.on('error', error => {
      console.error(`[${projectName}] Watcher error: ${error.message}`);
    });

    this.projects.set(gitlocation, {
      gitlink,
      watcher,
      commitTimeout: null,
      ignoreInstance
    });

    console.log(`[${projectName}] Started watching for changes`);
  }

  handleFileChange(projectPath, filePath, ignoreInstance) {
    const projectName = path.basename(projectPath);
    const project = this.projects.get(projectPath);
    
    if (!project) return;

    // Check if file should be ignored
    if (shouldIgnorePath(projectPath, filePath, ignoreInstance)) {
      return;
    }

    // Clear existing timeout
    if (project.commitTimeout) {
      clearTimeout(project.commitTimeout);
    }

    // Schedule commit with debounce
    project.commitTimeout = setTimeout(async () => {
      project.commitTimeout = null;
      const relativePath = path.relative(projectPath, filePath);
      console.log(`\n[${projectName}] Change detected: ${relativePath}`);
      await commitChanges(projectPath, this.userInfo);
    }, this.commitDebounceMs);
  }

  async pushAllProjects() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Pushing all projects to GitHub...`);
    console.log(`${'='.repeat(60)}`);

    for (const [projectPath, project] of this.projects) {
      await pushToGitHub(projectPath, project.gitlink, this.token, this.userInfo);
    }

    console.log(`${'='.repeat(60)}`);
    console.log('Push complete');
    console.log(`${'='.repeat(60)}\n`);
  }

  setCommitDebounce(ms) {
    this.commitDebounceMs = ms;
  }

  async close() {
    for (const [_, project] of this.projects) {
      if (project.commitTimeout) {
        clearTimeout(project.commitTimeout);
      }
      if (project.watcher) {
        await project.watcher.close();
      }
    }
  }
}

// Main function
async function main() {
  console.log('=== RepoPush Enhanced ===');
  console.log('Auto-commit on file changes + Timed GitHub sync\n');

  const envPath = getEnvPath();
  
  if (!fs.existsSync(envPath)) {
    console.error(`ERROR: .env file not found at ${envPath}`);
    process.exit(1);
  }

  // Read config
  const config = parseEnvFile(envPath);

  if (!config.token) {
    console.error('ERROR: GitHub token not found in .env file');
    process.exit(1);
  }

  if (config.projects.length === 0) {
    console.log('No projects configured in .env file');
    process.exit(1);
  }

  // Get user info from .env or fetch from GitHub
  let userInfo;
  
  if (config.gitAuthorName && config.gitAuthorEmail) {
    // Use credentials from .env
    console.log('Using git credentials from .env...');
    userInfo = {
      name: config.gitAuthorName,
      email: config.gitAuthorEmail,
      login: config.gitAuthorName // Fallback to name if no login
    };
  } else {
    // Fetch from GitHub API
    console.log('Fetching GitHub user information...');
    userInfo = await fetchGitHubUserInfo(config.token);
    
    if (!userInfo) {
      console.error('ERROR: Failed to fetch GitHub user information');
      console.error('Please add git_author_name and git_author_email to your .env file');
      process.exit(1);
    }
  }

  console.log(`Git Author: ${userInfo.name}`);
  console.log(`Commit Email: ${userInfo.email}`);
  console.log(`Projects to watch: ${config.projects.length}`);
  console.log(`Commit debounce: ${config.commitDebounceMs}ms`);
  console.log(`Push interval: ${config.syncTime} minutes\n`);

  // Create project manager
  const manager = new ProjectManager(config.token, userInfo);
  manager.setCommitDebounce(config.commitDebounceMs);

  // Add all projects
  for (const project of config.projects) {
    await manager.addProject(project.gitlink, project.gitlocation);
  }

  console.log('\n✓ All projects initialized');
  console.log('Monitoring for file changes and will push to GitHub every', config.syncTime, 'minutes');
  console.log('Press Ctrl+C to stop\n');

  // Commit any pending changes in all projects on startup
  console.log('============================================================');
  console.log('Committing any pending changes in all projects...');
  console.log('============================================================\n');
  
  for (const project of config.projects) {
    const projectPath = project.gitlocation;
    const projectName = path.basename(projectPath);
    
    // Check if directory exists and is a git repo
    if (!fs.existsSync(projectPath)) {
      console.log(`[${projectName}] Skipping - directory doesn't exist`);
      continue;
    }
    
    const isRepo = await isGitRepo(projectPath);
    if (!isRepo) {
      console.log(`[${projectName}] Skipping - not a git repository`);
      continue;
    }
    
    // Commit any changes
    const committed = await commitChanges(projectPath, userInfo);
    if (!committed) {
      console.log(`[${projectName}] No changes to commit`);
    }
  }

  console.log('\n============================================================');
  console.log('Startup commits complete - syncing to GitHub...');
  console.log('============================================================\n');

  // Schedule periodic pushes
  const syncIntervalMs = config.syncTime * 60 * 1000;
  const intervalId = setInterval(async () => {
    await manager.pushAllProjects();
  }, syncIntervalMs);

  // Perform initial push
  await manager.pushAllProjects();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n\nShutting down...');
    clearInterval(intervalId);
    await manager.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run main
main().catch(error => {
  console.error(`FATAL: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
