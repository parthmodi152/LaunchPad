const express = require('express')
const httpProxy = require('http-proxy')
const { PrismaClient } = require('@prisma/client')

const app = express()
const PORT = 8000

const BASE_PATH = 'https://vercel-clone-outputs-1.s3.ap-south-1.amazonaws.com/__outputs'

const proxy = httpProxy.createProxy()
const prisma = new PrismaClient()

app.use(async (req, res) => {
    const hostname = req.hostname;
    const subdomain = hostname.split('.')[0];
    
    // kafka event page visit

    const project = await prisma.project.findFirst({
        where: {
            OR: [
                { subDomain: subdomain },
                { customDomain: subdomain }
            ]
        }
    })

    if (!project) {
        return res.status(404).json({ error: 'Project not found' })
    }

    const project_id = project.id
    const resolvesTo = `${BASE_PATH}/${project_id}`

    return proxy.web(req, res, { target: resolvesTo, changeOrigin: true })

})



proxy.on('proxyReq', (proxyReq, req, res) => {
    const url = req.url;
    if (url === '/')
        proxyReq.path += 'index.html'

})

app.listen(PORT, () => console.log(`Reverse Proxy Running..${PORT}`))