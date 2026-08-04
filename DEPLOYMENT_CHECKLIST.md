# TrackR Railway deployment checklist

- [ ] Create a new Railway service from this project.
- [ ] Attach a persistent volume mounted at `/data`.
- [ ] Add `TRACKR_SECRET_KEY` with a long, random value.
- [ ] Confirm the service has exactly one replica.
- [ ] Confirm the deploy healthcheck passes at `/health`.
- [ ] Generate a Railway public domain.
- [ ] Sign in as `admin` and change the temporary password.
- [ ] Sign in as `factory` and change the temporary password.
- [ ] Create a test job and verify Jobs, Calendar and Schedule.
- [ ] Redeploy once and verify the test job still exists.
- [ ] Download an admin backup and store it safely.
