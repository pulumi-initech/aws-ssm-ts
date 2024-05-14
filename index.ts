import * as aws from "@pulumi/aws";
import { main } from "@pulumi/pulumi/provider";

// Create an IAM Role
const role = new aws.iam.Role("instanceRole", {
    assumeRolePolicy: {
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
                Service: "ec2.amazonaws.com",
            },
        }],
    },
});

// Attach the AmazonSSMFullAccess policy to the role
const policyAttachment = new aws.iam.RolePolicyAttachment("instanceRolePolicyAttachment", {
    role: role,
    policyArn: "arn:aws:iam::aws:policy/AmazonSSMFullAccess",
}, { parent: role });

const instanceProfile = new aws.iam.InstanceProfile("instanceProfile", {
    role: role.name,
}, { parent: role });

// Launch an EC2 instance with the SSM Agent installed
const ec2Instance = new aws.ec2.Instance("windowsInstance", {
    instanceType: "t2.micro",
    ami: "ami-0c0ec0a3a3a4c34c0", 
    iamInstanceProfile: instanceProfile.name,
    // Ensure that the SSM Agent is installed on the instance as part of the user data script
    userData: ` <powershell>
                    Install-WindowsFeature -Name "RSAT-AD-PowerShell" -IncludeAllSubFeature
                    # Include any other setup scripts here
                </powershell>`,
    tags: {
        "Name": "PatchMe",
        "OS": "Windows",
        "PatchGroup": "DEV"
    }
});

// Create an SSM Document to configure software on the Windows instance
const configureSoftwareDocument = new aws.ssm.Document("configureSoftware", {
    content: JSON.stringify({
        schemaVersion: "2.2",
        description: "Configure software on Windows instance",
        mainSteps: [
            {
                action: "aws:runPowerShellScript",
                name: "runPowerShellScript",
                inputs: {
                    runCommand: [
                        "Install-WindowsFeature -Name Web-Server",
                    ],
                },
            },
        ],
    }),
    documentType: "Command",
});

// Associate the SSM Document with the EC2 instance to configure the software
const ssmAssociation = new aws.ssm.Association("ssmAssociation", {
    name: configureSoftwareDocument.name,
    targets: [{
        key: "InstanceIds",
        values: [ec2Instance.id],
    }],
}, { parent: configureSoftwareDocument });

// Create an SSM Patch Baseline for patching operations
const patchBaseline = new aws.ssm.PatchBaseline("patchBaseline", {
    operatingSystem: "WINDOWS",
    approvalRules: [{
            approveAfterDays: 7,
            complianceLevel: "CRITICAL",
            patchFilters: [
                { key: "PRODUCT", values: ["WindowsServer2022"] },
                { key: "CLASSIFICATION", values: ["CriticalUpdates"] },
            ],
    }],
});

const patchGroup = new aws.ssm.PatchGroup("patchGroup", {
    baselineId: patchBaseline.id,
    patchGroup: "DEV",
});

// Create an SSM maintenance window
const maintenanceWindow = new aws.ssm.MaintenanceWindow("maintenanceWindow", {
    schedule: "cron(0 2 ? * SUN *)", // Run every Sunday at 2 AM
    duration: 3, // Duration is 3 hours
    cutoff: 1, // Stop tasks 1 hour before the end of the window
});

// Register the target (our EC2 instance) with the maintenance window
const maintenanceWindowTarget = new aws.ssm.MaintenanceWindowTarget("windowTarget", {
    windowId: maintenanceWindow.id,
    resourceType: "INSTANCE",
    targets: [{
        key: "tag:PatchGroup",
        values: ["DEV"],
    }],
}, { parent: maintenanceWindow });

// Register a task with the maintenance window to apply patches
const maintenanceWindowTask = new aws.ssm.MaintenanceWindowTask("windowTask", {
    windowId: maintenanceWindow.id,
    taskType: "RUN_COMMAND",
    targets: [{
        key: "WindowTargetIds",
        values: [maintenanceWindowTarget.id],
    }],
    taskArn: "AWS-RunPatchBaseline",
    maxConcurrency: "1",
    maxErrors: "1",
    taskInvocationParameters: {
        runCommandParameters: {
            documentVersion: "$LATEST",
            parameters: [{
                name: "commands",
                values: [
                    "AWS-RunPatchBaseline", // AWS predefined SSM document for patching
                    `--baseline-id ${patchBaseline.id}`,
                    "--install-action Install",
                ],
            }],
        },
    },
}, { parent: maintenanceWindow });

// Export the IDs of the resources
export const ssmDocumentId = configureSoftwareDocument.id;
export const instanceId = ec2Instance.id;
export const patchBaselineId = patchBaseline.id;
