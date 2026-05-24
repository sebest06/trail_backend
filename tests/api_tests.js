/**
 * AppRadar API Integration Tests
 *
 * Este script prueba las funcionalidades principales del backend:
 * 1. Autenticación (Registro y Login)
 * 2. Gestión de Carreras (Creación, Listado, Activación)
 * 3. Seguimiento en Vivo (Carga de Runs, Tracks y GPS)
 * 4. Rankings y Sesiones
 */

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

// Colores para la consola
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const YELLOW = '\x1b[33m';

let adminToken = '';
let runnerToken = '';
let runnerUuid = '';
let testTrailUuid = '';
let testRunUuid = 'run-' + Date.now();
let testWaypointUuid = '';

async function runTests() {
    console.log(`${YELLOW}--- Iniciando Tests de AppRadar ---${RESET}\n`);

    try {
        // 1. LOGIN ADMIN (Semilla por defecto)
        await test('Login Admin (Superuser)', async () => {
            const res = await request('/auth/login', 'POST', { user: 'admin', passw: '1234' });
            adminToken = res.token;
            if (!adminToken) throw new Error('No se obtuvo token de admin');
        });

        // 2. OBTENER EQUIPOS
        let teamUuid = '';
        await test('Obtener Lista de Equipos', async () => {
            const teams = await request('/teams', 'GET');
            if (teams.length > 0) {
                teamUuid = teams[0].uuid_team;
                console.log(`   Usando equipo: ${teams[0].team}`);
            } else {
                console.log('   No hay equipos, usando el del admin para el registro');
            }
        });

        // 3. REGISTRO DE CORREDOR
        await test('Registro de Nuevo Corredor', async () => {
            const userData = {
                user: 'runner' + Date.now(),
                passw: 'password123',
                nombre: 'Test Runner',
                role: 'runner',
                uuid_team: teamUuid || 'admin-team-uuid'
            };
            const res = await request('/auth/register', 'POST', userData);
            runnerToken = res.token;
            runnerUuid = res.user.uuid;
            if (!runnerToken) throw new Error('No se pudo registrar el corredor');
        });

        // 4. CREAR UNA CARRERA (Como Admin)
        await test('Crear Nueva Carrera (Trail)', async () => {
            const trailData = {
                name: 'Maratón de Prueba',
                description: 'Una carrera para testear el sistema',
                distanceKm: 5.0,
                elevationM: 200,
                maxSkip: 1,
                waypoints: [
                    { order: 0, name: 'Salida', lat: -34.6037, lon: -58.3816, radius: 50 },
                    { order: 1, name: 'Punto Medio', lat: -34.6050, lon: -58.3830, radius: 50 },
                    { order: 2, name: 'Meta', lat: -34.6070, lon: -58.3850, radius: 50 }
                ]
            };
            const res = await request('/trails', 'POST', trailData, adminToken);
            testTrailUuid = res.trailUuid;
            if (!testTrailUuid) throw new Error('No se creó la carrera');
        });

        // 5. LISTAR CARRERAS
        await test('Listar Carreras Disponibles', async () => {
            const trails = await request('/trails', 'GET', null, runnerToken);
            const found = trails.find(t => t.trailUuid === testTrailUuid);
            if (!found) throw new Error('La carrera creada no aparece en la lista');
        });

        // 6. ACTIVAR CARRERA
        await test('Activar Carrera', async () => {
            await request(`/trails/${testTrailUuid}/activate`, 'POST', null, adminToken);
            const details = await request(`/trails/${testTrailUuid}/details`, 'GET');
            if (!details.isActive) throw new Error('La carrera no se activó correctamente');
            testWaypointUuid = details.waypoints[0].waypointUuid;
        });

        // 7. INICIAR CARRERA (Upload Run)
        await test('Subir Inicio de Carrera (Run)', async () => {
            const runData = {
                runUuid: testRunUuid,
                trailUuid: testTrailUuid,
                userUuid: runnerUuid,
                startTime: Date.now(),
                isCompleted: false
            };
            const res = await request('/runs/upload', 'POST', runData, runnerToken);
            if (!res.ok || !res.sessionUuid) throw new Error('Error al subir el run');
        });

        // 8. SUBIR WAYPOINT ALCANZADO (Track)
        await test('Subir Waypoint Alcanzado (Track)', async () => {
            const trackData = [{
                trackUuid: 'track-' + Date.now(),
                runUuid: testRunUuid,
                waypointUuid: testWaypointUuid,
                trailUuid: testTrailUuid,
                userUuid: runnerUuid,
                timestamp: Date.now()
            }];
            const res = await request('/tracks/upload', 'POST', trackData, runnerToken);
            if (!res.ok) throw new Error('Error al subir el track');
        });

        // 9. SUBIR POSICION GPS
        await test('Subir Posición GPS en Vivo', async () => {
            const gpsData = {
                trailUuid: testTrailUuid,
                lat: -34.6040,
                lon: -58.3820,
                accuracy: 5.0,
                timestamp: Date.now()
            };
            const res = await request('/gps/upload', 'POST', gpsData, runnerToken);
            if (!res.ok) throw new Error('Error al subir GPS');
        });

        // 10. OBTENER RANKINGS
        await test('Consultar Rankings', async () => {
            const rankings = await request(`/rankings?trailUuid=${testTrailUuid}`, 'GET');
            const userInRank = rankings.find(r => r.userUuid === runnerUuid);
            if (!userInRank || userInRank.waypointsReached < 1) {
                throw new Error('El corredor no aparece en el ranking con sus waypoints');
            }
        });

        // 11. ABANDONAR CARRERA
        await test('Abandonar Carrera (Update Run)', async () => {
            const runData = {
                runUuid: testRunUuid,
                trailUuid: testTrailUuid,
                userUuid: runnerUuid,
                startTime: Date.now() - 5000,
                endTime: Date.now(),
                totalTime: 5000,
                isCompleted: false,
                isAbandoned: true
            };
            const res = await request('/runs/upload', 'POST', runData, runnerToken);
            if (!res.ok) throw new Error('Error al abandonar la carrera');

            const rankings = await request(`/rankings?trailUuid=${testTrailUuid}`, 'GET');
            const userInRank = rankings.find(r => r.userUuid === runnerUuid);
            if (!userInRank.isAbandoned) throw new Error('El ranking no muestra el abandono');
        });

        // 12. VALIDAR RESTRICCIÓN DE 1 HORA
        await test('Validar Restricción de 1 Hora', async () => {
            const runData = {
                runUuid: 'run-too-soon-' + Date.now(),
                trailUuid: testTrailUuid,
                userUuid: runnerUuid,
                startTime: Date.now(),
                isCompleted: false
            };
            try {
                await request('/runs/upload', 'POST', runData, runnerToken);
                throw new Error('El servidor permitió iniciar una carrera antes de que pase 1 hora');
            } catch (e) {
                if (e.message.includes('403')) {
                    console.log(`   Bloqueo correcto: ${e.message}`);
                } else {
                    throw e;
                }
            }
        });

        console.log(`\n${GREEN}--- Todos los tests pasaron exitosamente ---${RESET}`);

    } catch (error) {
        console.error(`\n${RED}!!! Test Fallido !!!${RESET}`);
        console.error(`${RED}${error.message}${RESET}`);
        process.exit(1);
    }
}

async function test(name, fn) {
    process.stdout.write(`Prueba: ${name}... `);
    try {
        await fn();
        console.log(`${GREEN}PASÓ${RESET}`);
    } catch (e) {
        console.log(`${RED}FALLÓ${RESET}`);
        throw e;
    }
}

async function request(path, method = 'GET', body = null, token = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json'
        }
    };

    if (token) {
        options.headers['Authorization'] = `Bearer ${token}`;
    }

    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(BASE_URL + path, options);

    if (response.status === 204) return null;

    const data = await response.json();
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${data.error || response.statusText}`);
    }
    return data;
}

runTests();
