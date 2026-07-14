import { execFile } from 'child_process'

export function getGitBranch(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolve('')
        return
      }
      const branch = stdout.trim()
      resolve(branch === 'HEAD' ? '' : branch)
    })
  })
}
