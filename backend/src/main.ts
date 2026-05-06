import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AppRole, getAppRole, isHttpRole } from './common/runtime/app-role';
import { AppApiModule } from './app-api.module';
import { AppSignalWorkerModule } from './app-signal-worker.module';
import { AppAuditWorkerModule } from './app-audit-worker.module';

function getRootModule(role: AppRole) {
  switch (role) {
    case 'api':
      return AppApiModule;
    case 'signal-worker':
      return AppSignalWorkerModule;
    case 'audit-worker':
      return AppAuditWorkerModule;
    case 'all':
    default:
      return AppModule;
  }
}

async function bootstrapHttp(role: AppRole) {
  const app = await NestFactory.create(getRootModule(role));

  // Enable graceful shutdown hooks (triggers onModuleDestroy)
  app.enableShutdownHooks();

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS for frontend
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  // Global prefix
  app.setGlobalPrefix('api');

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`[IMS] ${role} server running on http://localhost:${port}`);
}

async function bootstrapWorker(role: AppRole) {
  const app = await NestFactory.createApplicationContext(getRootModule(role));

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`[IMS] ${role} received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  console.log(`[IMS] ${role} context started`);
}

async function bootstrap() {
  const role = getAppRole();

  if (isHttpRole(role)) {
    await bootstrapHttp(role);
    return;
  }

  await bootstrapWorker(role);
}

bootstrap();
