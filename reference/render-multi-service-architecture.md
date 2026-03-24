# Multi-Service Architectures on Render


> *This guide teaches you how to:*
>
> - Combine different Render service types into a common web app architecture
> - Set up connections between services using environment variables
> - Communicate between services over a private network

Modern cloud applications usually consist of multiple connected services:

[diagram]

A *multi-service architecture* like this one enables you to deploy, scale, and even swap out individual parts of your app—all with minimal impact on the rest of your system.

The Render platform is designed from the ground up to support multi-service architectures. You can assemble different [service types](service-types) into any combination you need, using any set of languages and frameworks.

Let's look at an example.

## Example scenario

A common multi-service web app might consist of:

- A React or Next.js website for the app's frontend
- An Express or Django API server to handle requests from clients
- A relational database for long-term storage of application data

We can represent each of these components as a separate service on Render:

| Component    | Service Type                                                                                                | Common Frameworks        |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| *Frontend* | Static site (or a web service if the frontend includes server-side logic) | React, Next.js, Vue.js   |
| *Backend*  | Web service                                                                                | Django, Express, FastAPI |
| *Database* | Render Postgres database                                                                     |                          |

Let's walk through deploying an app with these components. You can apply these steps to your own app, regardless of which frameworks you use.

## Prerequisites

Before we start deploying, confirm all of the following:

1. You've created your [Render account](https://dashboard.render.com/register).
2. Each project you want to deploy is one of the following:
   - A repository hosted on GitHub, GitLab, or Bitbucket
   - A Docker image in a [supported registry](/deploying-an-image), such as Docker Hub
3. Your full application works as expected on your local machine.
4. You've consulted your chosen framework's documentation for specific deployment guidance.
   - For example, here's the [deployment guide for Next.js](https://nextjs.org/docs/pages/building-your-application/deploying#self-hosting).

## Steps to deploy

In the steps below, we'll first deploy each component of our architecture. Then, we'll connect them by setting environment variables.

### 1. Create a database

Render provides fully managed PostgreSQL databases with [point-in-time recovery](postgresql-backups), along with reliability features like [read replicas](postgresql-read-replicas) and [high availability](postgresql-high-availability) for larger instances.

We can create a Render Postgres database with a few clicks in the [Render Dashboard](https://dashboard.render.com):

[image: Creating a new Postgres database in the Render Dashboard]

Follow [these steps](postgresql-creating-connecting#create-your-database), then return here.

### 2. Deploy the backend

Our application's backend will handle incoming HTTP requests from browsers and other clients. To support this, we'll create a *web service*.

Web services receive a public `onrender.com` URL, and you can add your own [custom domains](custom-domains). You can use virtually any web framework for your web service (Django, Express, FastAPI, and so on).

> To deploy a backend that only receives traffic from your own Render infrastructure, create a [private service](private-services) instead.

1. Make sure that on startup, your backend code binds an HTTP server to a port on host `0.0.0.0`.

   - We recommend binding to the value of the `PORT` environment variable (default `10000`).
   - If you're building from a Dockerfile, indicate your HTTP port in the file like so:

     ```dockerfile
     EXPOSE 10000
     ```

     Learn more about the [`EXPOSE` instruction](https://docs.docker.com/reference/dockerfile/#expose).

2. Create a new web service in the same region as your database and deploy your backend code to it.

   - Follow [these steps](web-services#deploy-your-own-code), then return here.

### 3. Deploy the frontend

Our application's frontend will serve the content that users view and interact with in their browser.

Depending on our frontend's framework, we'll deploy our code as either a *static site* or a second *web service*:

------

###### Service type

**Static site**

###### When to use

For apps with entirely static content (HTML/CSS/JS)

###### Example frameworks

React, Vue.js, Next.js ([static exports](https://nextjs.org/docs/pages/building-your-application/deploying/static-exports) only)

---

###### Service type

**Web service**

###### When to use

For apps with server-side logic

###### Example frameworks

Next.js, Nuxt.js

------

Render static sites are served by a globally distributed CDN, so we recommend using them for any framework that supports it.

To deploy your frontend, follow the instructions for your chosen service type, then return here:

- [Static site](static-sites#get-started)
- [Web service](web-services#deploy-your-own-code)

### 4. Connect your services

After creating and deploying our services, we need to configure them to communicate with each other. To do this, we can set [environment variables](configure-environment-variables) on a service to specify the address of each _other_ service it connects to:

[diagram]

Let's set up connections for our frontend and backend services.

#### Update the frontend service

1. Look up the [public URL](web-services#connecting-from-the-public-internet) of your backend service.

2. [Add an environment variable](configure-environment-variables#setting-environment-variables) to your frontend service:

   - Give the environment variable a helpful name (such as `BACKEND_URL`) and set its value to your backend's public URL.
   - For static site frameworks, you might need to use a specific name for the environment variable (such as `REACT_APP_BACKEND_URL` for React).

3. Update your frontend code to use the new environment variable to connect to your backend. For example, in JavaScript:

   ```javascript
   // Use BACKEND_URL if set, otherwise default to localhost
   const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000'

   // Basic example of fetching data from your backend
   fetch(`${BACKEND_URL}/api/data`)
     .then((response) => response.json())
     .then((data) => console.log(data))
   ```

4. Push your updated code to your linked branch to deploy your changes.

#### Update the backend service

1. Look up the public URL of your frontend service.

2. Look up the [internal address](private-network#how-to-connect) of your Render Postgres database.

   - Backend services on Render can communicate with each other using their "internal" (or "private") addresses. When you use an internal address, traffic between the services stays on their private network—it doesn’t traverse the open internet.

3. [Add environment variables](configure-environment-variables#setting-environment-variables) to your backend service:

   - Define a `FRONTEND_URL` variable and set its value to the frontend's public URL.
   - Define a `DATABASE_URL` variable and set its value to the database's internal address.

4. Update your backend code to use the `FRONTEND_URL` and `DATABASE_URL` environment variables to connect. See examples below.

   - Using `FRONTEND_URL` to set CORS headers in Express middleware:

     ```javascript
     // Use FRONTEND_URL if set, otherwise default to localhost
     const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000'

     // Set CORS headers to allow requests from the frontend
     app.use((req, res, next) => {
       res.setHeader('Access-Control-Allow-Origin', FRONTEND_URL)
       next()
     })
     ```

   - Using `DATABASE_URL` to connect to a database with the `pg` Node.js library:

     ```javascript
     const { Pool } = require('pg')

     const pool = new Pool({
       connectionString: process.env.DATABASE_URL,
     })
     ```

5. Push your updated code to your linked branch to deploy your changes.

After your frontend and backend deploys complete, your app should be up and running! Visit your frontend URL to confirm. If you encounter any issues, see [Troubleshooting Deploys](troubleshooting-deploys).

## Consider infrastructure as code (IaC)

As your architecture grows in scale, it becomes more and more helpful to manage your services in a unified way. [Render Blueprints](infrastructure-as-code) enable you to configure and update the entire architecture of your app with a single YAML file.

*Show example Blueprint*

```yaml
# This is a basic example Blueprint for a Django web service and
# the Render Postgres database it connects to.
services:
  - type: web # A Python web service named django-app running on a free instance
    plan: free
    name: django-app
    runtime: python
    repo: https://github.com/render-examples/django.git
    buildCommand: './build.sh'
    startCommand: 'python -m gunicorn mysite.asgi:application -k uvicorn.workers.UvicornWorker'
    envVars:
      - key: DATABASE_URL # Sets DATABASE_URL to the connection string of the django-app-db database
        fromDatabase:
          name: django-app-db
          property: connectionString

databases:
  - name: django-app-db # A Render Postgres database named django-app-db running on a free instance
    plan: free
```

You can even [generate a Blueprint](infrastructure-as-code#generating-a-blueprint-from-existing-services) for your existing services, which makes it much faster to get started.

---

##### Appendix: Glossary definitions

###### static site

Deploy this *service type* to host a static website (HTML/CSS/JS) over a global CDN at a public URL.

Related article: https://render.com/docs/static-sites.md

###### web service

Deploy this *service type* to host a dynamic application at a public URL.

Ideal for full-stack web apps and API servers.

Related article: https://render.com/docs/web-services.md

###### Render Postgres

Fully managed PostgreSQL databases that support point-in-time recovery, read replicas, high availability, and more.

Related article: https://render.com/docs/postgresql.md
