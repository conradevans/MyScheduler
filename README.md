# MyScheduler

MyScheduler is a full-stack React workforce scheduling app. It combines reusable events, worker availability, workplace coverage rules, roles, work shifts, templates, and a fairness-aware auto-scheduler.

## Included features

- Login and account creation
- Passwords hashed with bcrypt (12 rounds)
- JWT authentication stored in an HTTP-only cookie
- MongoDB/Mongoose persistence
- Current-month calendar with clickable Monday–Sunday week rows
- Week view from 5:00 AM to 10:00 PM
- Reusable event templates with exact duration in minutes
- Scheduled-event placement in 5-minute drag increments, plus exact start/end editing
- Scheduled events cannot overlap
- Reusable workers with max weekly hours
- Worker roles such as Coach, Manager, Front Desk, etc.
- Recurring unavailability (for example, never available Fridays)
- Date-specific time off (for example, away for a weekend)
- Event role requirements, including required counts (for example, 1 Coach)
- Workplace settings for open time, close time, minimum on-site staffing, and standard generated shift length
- Auto-generated full-length work shifts with hourly handoff opportunities
- Baseline workplace coverage even when no event is taking place
- Event demand can increase staffing above the workplace minimum
- A worker receives at most one continuous shift per day; split shifts are not generated
- Manual worker-to-event assignments are locked by default
- Lock/unlock individual assignments
- Fair auto-scheduler that considers current-week hours, previous-week hours, max weekly hours, availability, roles, and shift conflicts
- Saved day/week templates can include event placement, work shifts, and event assignments
- Copied workers are revalidated before being pasted into another day/week
- Short events show worker names in compact form, with full worker coverage details on hover
- Daily Staffing Board groups every worker shift by day, with times, roles, assigned events, and manual/generated status
- Workplace shift definitions appear as gray open positions until a worker is assigned manually or by the generator

## Project structure

```text
MyScheduler/
  client/                 React + Vite
  server/                 Express + MongoDB
    models/
    routes/
    middleware/
    utils/
```

## 1. Set up MongoDB

You can use either a local MongoDB instance or MongoDB Atlas.

For local MongoDB, the default URI is:

```text
mongodb://127.0.0.1:27017/myscheduler
```

## 2. Configure the server

```bash
cd server
cp .env.example .env
```

Then edit `server/.env`:

```env
PORT=5000
MONGODB_URI=mongodb://127.0.0.1:27017/myscheduler
JWT_SECRET=put-a-long-random-secret-here
CLIENT_ORIGIN=http://localhost:5173
NODE_ENV=development
```

For MongoDB Atlas, replace `MONGODB_URI` with your Atlas connection string.

## 3. Install dependencies

From the project root:

```bash
npm install
npm run install:all
```

## 4. Run the app

```bash
npm run dev
```

This starts:

- React/Vite at `http://localhost:5173`
- Express at `http://localhost:5000`

Open `http://localhost:5173`.

## Workplace coverage

Open the weekly scheduler and click **Workplace hours & staffing**. You can set:

- opening time
- closing time
- minimum number of people who must always be working
- standard generated shift length in hours

Workplace hours must fit inside the existing 5:00 AM–10:00 PM timetable.

The generator uses hourly handoff opportunities, but workers are not given hourly fragments. Every generated worker receives one continuous full-length shift for that day. MyScheduler will not schedule someone for a short 1–2 hour fragment or bring them back later for a second shift.

Example:

```text
Open: 6:00 AM
Close: 9:00 PM
Minimum working: 2
Shift length: 4 hours
```

MyScheduler will maintain at least two active work shifts through the day. If an event at 3:00 PM needs four workers, the required coverage rises to four during that event.

## Staffing Board

The weekly page includes a **Daily shift roster** above the timetable. Each day groups the actual workplace shifts and shows:

- worker name
- exact shift start/end
- shift length
- worker roles
- events that worker is covering during the shift
- whether the shift is manual/locked or auto-generated

The board can be hidden when you want more vertical room for the timetable.

## Roles

Workers can have multiple roles:

```text
Coach, Front Desk, Manager
```

Events can optionally require one or more roles. For example:

```text
People needed: 3
Required roles:
- Coach: 1
```

That means the event needs three people total, and at least one of those positions must be filled by a worker with the Coach role.

Role counts cannot exceed the total number of people needed.

## How the generator works

When **Generate schedule** is clicked, the backend:

1. Keeps locked/manual assignments and locked work shifts.
2. Removes old unlocked generated shifts and generated event assignments.
3. Reads workplace open/close times, minimum coverage, and standard shift length.
4. Calculates each worker's current-week and previous-week workload.
5. Builds coverage intervals using hourly handoff points plus exact event start/end times.
6. Creates only full standard shifts and limits each worker to one continuous shift per day.
7. Raises coverage when an event needs more people than the workplace minimum.
8. Prioritizes required roles before general staffing positions and tries not to consume scarce role workers too early in the day.
9. Rejects workers who are unavailable, already have a shift that day, or would exceed their weekly maximum.
10. Favors workers with fewer current and previous-week hours, with a small amount of weighted randomness for fairness.
11. Creates work shifts first.
12. Assigns on-shift workers to event coverage, preferring to keep the same worker on an event until their shift actually ends.
13. Reports any period it cannot fully cover instead of creating short/split shifts or violating constraints.

## Event scheduling notes

- Dragging an event snaps its start time to 5-minute increments.
- Event duration is entered in whole minutes and can be any value from 1 to 1020 minutes.
- Click a scheduled event to edit its exact start or end time.
- Editing the start automatically recalculates the end from the event duration.
- Editing the end automatically recalculates the start.
- Events cannot overlap each other.
- Short events show a compact roster; hovering any event shows its full worker coverage and any shift-specific time ranges.

## Manual worker assignments

Dragging a worker directly onto an event creates an intentional locked assignment for the whole event. If the worker does not already have a shift that day, MyScheduler creates one full standard shift that covers the event. It will not create an event-length 20-minute/2-hour work shift or a second split shift later that day. MyScheduler validates:

- recurring unavailability
- date-specific time off
- event conflicts
- weekly hour limits
- role feasibility

If the worker already has a shift that day, the event must fall inside that shift. Otherwise the assignment is rejected instead of creating a second shift. Locked choices survive auto-generation.

## Day and week schedule templates

The weekly scheduler can save the current schedule as reusable **day** or **week** templates.

Templates can store:

- scheduled event placement
- event role requirements
- work shifts
- event worker assignments and their coverage times

When you paste a template, you can choose whether to copy workers and shifts. Every copied worker placement is revalidated against availability, time off, shift overlap, weekly limits, and role requirements. Invalid worker placements are skipped and reported instead of being forced onto the new schedule.

## Production build

```bash
npm run build
```

Then set:

```env
NODE_ENV=production
```

and run:

```bash
npm start
```

In production mode the Express server serves `client/dist`.

## Deploy on Render

The included `render.yaml` deploys the client and server together as one Render web service. Keeping them on the same origin lets the existing secure authentication cookie work without a separate frontend deployment.

1. Push this repository to GitHub.
2. Create a MongoDB Atlas database and copy its connection string.
3. In Render, create a **Blueprint** from the GitHub repository.
4. Enter the Atlas connection string when Render asks for `MONGODB_URI`.
5. Deploy, then open the Render URL and create the first account.

Render generates `JWT_SECRET` automatically. Never commit `server/.env` or paste production secrets into this repository.

The health check is available at `/api/health`. On Render's free web-service tier, the app can sleep while idle, so the first visit after inactivity may take about a minute to respond.

## Optional: start MongoDB with Docker

```bash
docker compose up -d
```

The included compose file exposes MongoDB at `mongodb://127.0.0.1:27017`, matching the default `.env.example` URI.
