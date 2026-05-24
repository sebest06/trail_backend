const { Given, When, Then, BeforeAll } = require('@cucumber/cucumber');
const { expect } = require('chai');

const BASE_URL = 'http://localhost:3000';

let adminToken = '';
let runnerToken = '';
let runnerUuid = '';
let trailUuid = '';
let runUuid = '';
let waypointUuid = '';
let sessionUuid = '';

// Helper para peticiones
async function request(path, method = 'GET', body = null, token = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (token) options.headers['Authorization'] = `Bearer ${token}`;
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(BASE_URL + path, options);
    if (response.status === 204) return null;

    const data = await response.json();
    return { status: response.status, data };
}

Given('que estoy registrado como un corredor llamado {string} en el equipo {string}', async function (nombre, equipo) {
    // Primero logueamos al admin para ver equipos o crear uno si hace falta
    const adminLogin = await request('/auth/login', 'POST', { user: 'admin', passw: '1234' });
    adminToken = adminLogin.data.token;

    const teams = await request('/teams', 'GET');
    const team = teams.data[0] || { uuid_team: 'admin-team-uuid' };

    const username = 'user_' + Date.now();
    const res = await request('/auth/register', 'POST', {
        user: username,
        passw: 'password123',
        nombre: nombre,
        role: 'runner',
        uuid_team: team.uuid_team
    });

    expect(res.status).to.equal(201);
    runnerToken = res.data.token;
    runnerUuid = res.data.user.uuid;
});

Given('existe una carrera llamada {string} creada por el administrador', async function (nombreCarrera) {
    const trailData = {
        name: nombreCarrera,
        description: 'Carrera de prueba BDD',
        distanceKm: 10,
        elevationM: 500,
        maxSkip: 1,
        waypoints: [
            { order: 0, name: 'Inicio', lat: -31.4, lon: -64.1, radius: 50 },
            { order: 1, name: 'Meta', lat: -31.5, lon: -64.2, radius: 50 }
        ]
    };
    const res = await request('/trails', 'POST', trailData, adminToken);
    expect(res.status).to.equal(201);
    trailUuid = res.data.trailUuid;
});

When('el administrador activa la carrera {string}', async function (string) {
    const res = await request(`/trails/${trailUuid}/activate`, 'POST', null, adminToken);
    expect(res.status).to.equal(200);
});

Then('yo puedo ver la carrera {string} en mi lista de carreras disponibles', async function (nombre) {
    const res = await request('/trails', 'GET', null, runnerToken);
    const trail = res.data.find(t => t.name === nombre);
    expect(trail).to.not.be.undefined;
    expect(trail.isActive).to.be.true;
});

When('inicio la carrera {string}', async function (string) {
    runUuid = 'run_' + Date.now();
    const res = await request('/runs/upload', 'POST', {
        runUuid: runUuid,
        trailUuid: trailUuid,
        userUuid: runnerUuid,
        startTime: Date.now(),
        isCompleted: false
    }, runnerToken);
    expect(res.status).to.equal(200);
    sessionUuid = res.data.sessionUuid;
});

When('alcanzo el primer waypoint de la carrera', async function () {
    const details = await request(`/trails/${trailUuid}/details`, 'GET');
    waypointUuid = details.data.waypoints[0].waypointUuid;

    const res = await request('/tracks/upload', 'POST', [{
        trackUuid: 'track_' + Date.now(),
        runUuid: runUuid,
        waypointUuid: waypointUuid,
        trailUuid: trailUuid,
        userUuid: runnerUuid,
        timestamp: Date.now()
    }], runnerToken);
    expect(res.status).to.equal(200);
});

When('envío mi posición GPS actual', async function () {
    const res = await request('/gps/upload', 'POST', {
        trailUuid: trailUuid,
        lat: -31.4001,
        lon: -64.1001,
        accuracy: 10,
        timestamp: Date.now()
    }, runnerToken);
    expect(res.status).to.equal(200);
});

Then('mi nombre debe aparecer en el ranking de la carrera con {int} waypoint alcanzado', async function (cantidad) {
    const res = await request(`/rankings?trailUuid=${trailUuid}`, 'GET');
    const entry = res.data.find(r => r.userUuid === runnerUuid);
    expect(entry).to.not.be.undefined;
    expect(entry.waypointsReached).to.equal(cantidad);
});

When('decido abandonar la carrera antes de terminar', async function () {
    const res = await request('/runs/upload', 'POST', {
        runUuid: runUuid,
        trailUuid: trailUuid,
        userUuid: runnerUuid,
        startTime: Date.now() - 10000,
        endTime: Date.now(),
        totalTime: 10000,
        isCompleted: false,
        isAbandoned: true
    }, runnerToken);
    expect(res.status).to.equal(200);
});

Then('en la web de resultados mi estado debe figurar como {string}', async function (estado) {
    const res = await request(`/rankings?trailUuid=${trailUuid}`, 'GET');
    const entry = res.data.find(r => r.userUuid === runnerUuid);
    if (estado === "Abandonó") {
        expect(entry.isAbandoned).to.be.true;
    }
});

Then('si intento iniciar la carrera nuevamente de inmediato, el sistema debe denegarme el acceso por la restricción de {int} hora', async function (horas) {
    const res = await request('/runs/upload', 'POST', {
        runUuid: 'fail_run_' + Date.now(),
        trailUuid: trailUuid,
        userUuid: runnerUuid,
        startTime: Date.now(),
        isCompleted: false
    }, runnerToken);

    // El servidor devuelve 403 cuando se intenta correr antes de 1 hora
    expect(res.status).to.equal(403);
    expect(res.data.error).to.contain('esperar');
});
