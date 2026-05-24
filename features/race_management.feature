# language: es
Característica: Gestión de Carreras y Seguimiento
  Como organizador y corredor
  Quiero gestionar carreras y registrar mi progreso
  Para que los espectadores puedan ver los resultados en tiempo real

  Escenario: Ciclo de vida completo de una carrera
    Dado que estoy registrado como un corredor llamado "Juan" en el equipo "Team Test"
    Y existe una carrera llamada "Desafío de Montaña" creada por el administrador
    Cuando el administrador activa la carrera "Desafío de Montaña"
    Entonces yo puedo ver la carrera "Desafío de Montaña" en mi lista de carreras disponibles

    Cuando inicio la carrera "Desafío de Montaña"
    Y alcanzo el primer waypoint de la carrera
    Y envío mi posición GPS actual
    Entonces mi nombre debe aparecer en el ranking de la carrera con 1 waypoint alcanzado

    Cuando decido abandonar la carrera antes de terminar
    Entonces en la web de resultados mi estado debe figurar como "Abandonó"
    Y si intento iniciar la carrera nuevamente de inmediato, el sistema debe denegarme el acceso por la restricción de 1 hora
