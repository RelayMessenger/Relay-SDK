import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

export interface WindowsAcl {
  owner: string;
  user: string;
  sddl: string;
  rules: Array<{ sid: string; rights: number; type: string }>;
}
// Fixed script only. Paths/descriptors travel as JSON data, never shell interpolation.
// The subprocess never reads file contents or receives an Agent Token argument.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:RELAY_HANDOFF_ACL | ConvertFrom-Json
$path = $inputData.path
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($inputData.action -eq 'protect') {
  if ($inputData.directory) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
  else { $acl = New-Object System.Security.AccessControl.FileSecurity }
  if ($inputData.sddl) { $acl.SetSecurityDescriptorSddlForm($inputData.sddl) }
  else {
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue)
      if ($inputData.directory) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
      } else { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow') }
      $acl.AddAccessRule($rule)
    }
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}
$acl = Get-Acl -LiteralPath $path
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; type = $_.AccessControlType.ToString() }
})
@{ owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; user = $user.Value; sddl = $acl.Sddl; rules = $rules } | ConvertTo-Json -Depth 5 -Compress
`;

export function privateWindowsAcl(acl: WindowsAcl, directory = false, metadata = false): boolean {
  const trusted = new Set([acl.user, "S-1-5-18", "S-1-5-32-544"]);
  if (!acl.user || !acl.sddl || !trusted.has(acl.owner) || !Array.isArray(acl.rules)) return false;
  const write = 2 | 4 | 16 | 64 | 256 | 65536 | 262144 | 524288;
  const rights = directory || metadata ? write : write | 1 | 8;
  return acl.rules.every((rule) => rule.type === "Deny"
    || (rule.type === "Allow" && Number.isInteger(rule.rights) && (trusted.has(rule.sid) || (rule.rights & rights) === 0)));
}

// Windows PowerShell 5 must discover its own module path, not inherit the
// PowerShell 7 host's incompatible TypeData/module definitions. Child only.
export function aclChildEnvironment(parent: NodeJS.ProcessEnv, request: string): NodeJS.ProcessEnv {
  const child = { ...parent };
  for (const key of Object.keys(child)) if (key.toLowerCase() === "psmodulepath") delete child[key];
  child.RELAY_HANDOFF_ACL = request;
  return child;
}

async function run(path: string, action: "inspect" | "protect", directory: boolean, sddl?: string): Promise<WindowsAcl> {
  if (process.platform !== "win32") throw new Error("Native Windows ACL inspection requires Windows.");
  const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await promisify(execFile)(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, timeout: 15_000, maxBuffer: 1_048_576,
    env: aclChildEnvironment(process.env, JSON.stringify({ path, action, directory, ...(sddl ? { sddl } : {}) })),
  });
  return JSON.parse(stdout.replace(/^\uFEFF/u, "").trim()) as WindowsAcl;
}
export const inspectWindowsAcl = (path: string): Promise<WindowsAcl> => run(path, "inspect", false);
export const protectWindowsPath = (path: string, directory = false, sddl?: string): Promise<WindowsAcl> => run(path, "protect", directory, sddl);
