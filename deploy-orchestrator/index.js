const express = require('express')
const { generateSlug } = require('random-word-slugs')
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const cors = require('cors')
const { z } = require('zod')
const { PrismaClient } = require('@prisma/client')
const { createClient } = require('@clickhouse/client')
const { Kafka } = require('kafkajs')
const { v4: uuidv4 } = require('uuid')
const fs = require('fs')
const path = require('path')


const app = express()
const PORT = 9000

const prisma = new PrismaClient()

const KAFKA_BROKERS = JSON.parse(process.env.KAFKA_BROKERS)
const KAFKA_USERNAME = process.env.KAFKA_USERNAME
const KAFKA_PASSWORD = process.env.KAFKA_PASSWORD
const KAFKA_SSL_CA = Buffer.from(process.env.KAFKA_SSL_CA, "base64").toString("ascii")

const CLICKHOUSE_HOST = process.env.CLICKHOUSE_HOST
const CLICKHOUSE_USERNAME = process.env.CLICKHOUSE_USERNAME
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD

const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY

const ECS_CLUSTER = process.env.ECS_CLUSTER
const ECS_TASK = process.env.ECS_TASK
const ECS_SUBNETS = JSON.parse(process.env.ECS_SUBNETS)
const ECS_SECURITY_GROUPS = JSON.parse(process.env.ECS_SECURITY_GROUPS)

const kafka = new Kafka({
    clientId: `deploy-orchestrator-${DEPLOYEMENT_ID}`,
    brokers: KAFKA_BROKERS,
    ssl: {
        ca: [KAFKA_SSL_CA]
    },
    sasl: {
        username: KAFKA_USERNAME,
        password: KAFKA_PASSWORD,
        mechanism: 'plain'
    }

})

const client = createClient({
    host: CLICKHOUSE_HOST,
    database: 'default',
    username: CLICKHOUSE_USERNAME,
    password: CLICKHOUSE_PASSWORD
})

const consumer = kafka.consumer({ groupId: 'deploy-orchestrator-logs-consumer' })

io.on('connection', socket => {
    socket.on('subscribe', channel => {
        socket.join(channel)
        socket.emit('message', JSON.stringify({ log: `Subscribed to ${channel}` }))
    })
})

const ecsClient = new ECSClient({
    region: 'us-east-2',
    credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY
    }
})

app.use(express.json())
app.use(cors())

app.post('/project', async (req, res) => {
    const schema = z.object({
        name: z.string(),
        gitURL: z.string()
    })
    const safeParseResult = schema.safeParse(req.body)

    if (safeParseResult.error) return res.status(400).json({ error: safeParseResult.error })

    const { name, gitURL } = safeParseResult.data

    const project = await prisma.project.create({
        data: {
            name,
            gitURL,
            subDomain: generateSlug()
        }
    })

    return res.json({ status: 'success', data: { project } })

})

app.post('/deploy', async (req, res) => {
    const { projectId } = req.body

    const project = await prisma.project.findUnique({ where: { id: projectId } })

    if (!project) return res.status(404).json({ error: 'Project not found' })

    // Check if there is no running deployement
    const deployment = await prisma.deployement.create({
        data: {
            project: { connect: { id: projectId } },
            status: 'QUEUED',
        }
    })

    // Spin the container
    const command = new RunTaskCommand({
        cluster: ECS_CLUSTER,
        taskDefinition: ECS_TASK,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
            awsvpcConfiguration: {
                assignPublicIp: 'ENABLED',
                subnets: ECS_SUBNETS,
                securityGroups: ECS_SECURITY_GROUPS
            }
        },
        overrides: {
            containerOverrides: [
                {
                    name: 'build-runner-image',
                    environment: [
                        { name: 'GIT_REPOSITORY__URL', value: project.gitURL },
                        { name: 'PROJECT_ID', value: projectId },
                        { name: 'DEPLOYEMENT_ID', value: deployment.id },
                        { name: 'KAFKA_BROKERS', value: JSON.stringify(KAFKA_BROKERS) },
                        { name: 'KAFKA_USERNAME', value: KAFKA_USERNAME },
                        { name: 'KAFKA_PASSWORD', value: KAFKA_PASSWORD },
                        { name: 'KAFKA_SSL_CA', value: process.env.KAFKA_SSL_CA },
                        { name: 'AWS_ACCESS_KEY_ID', value: process.env.AWS_ACCESS_KEY_ID },
                        { name: 'AWS_SECRET_ACCESS_KEY', value: process.env.AWS_SECRET_ACCESS_KEY },
                    ]
                }
            ]
        }
    })

    await ecsClient.send(command);

    return res.json({ status: 'queued', data: { deploymentId: deployment.id } })

})


app.get('/logs/:id', async (req, res) => {
    const id = req.params.id;
    const logs = await client.query({
        query: `SELECT event_id, deployment_id, log, timestamp from log_events where deployment_id = {deployment_id:String}`,
        query_params: {
            deployment_id: id
        },
        format: 'JSONEachRow'
    })

    const rawLogs = await logs.json()

    return res.json({ logs: rawLogs })
})

async function initkafkaConsumer() {
    await consumer.connect();
    await consumer.subscribe({ topics: ['container-logs'], fromBeginning: true })

    await consumer.run({

        eachBatch: async function ({ batch, heartbeat, commitOffsetsIfNecessary, resolveOffset }) {

            const messages = batch.messages;
            console.log(`Recv. ${messages.length} messages..`)
            for (const message of messages) {
                if (!message.value) continue;
                const stringMessage = message.value.toString()
                const { PROJECT_ID, DEPLOYEMENT_ID, log } = JSON.parse(stringMessage)
                console.log({ log, DEPLOYEMENT_ID })
                try {
                    const { query_id } = await client.insert({
                        table: 'log_events',
                        values: [{ event_id: uuidv4(), deployment_id: DEPLOYEMENT_ID, log }],
                        format: 'JSONEachRow'
                    })
                    console.log(query_id)
                    resolveOffset(message.offset)
                    await commitOffsetsIfNecessary(message.offset)
                    await heartbeat()
                } catch (err) {
                    console.log(err)
                }

            }
        }
    })
}

initkafkaConsumer()

app.listen(PORT, () => console.log(`API Server Running..${PORT}`))