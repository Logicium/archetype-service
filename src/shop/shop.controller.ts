import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'
import type { Request } from 'express'
import { ShopService } from './shop.service'
import type { ShopConfig } from '../entities/site.entity'
import type { FulfillmentType, ShippingAddress } from '../entities/shop-order.entity'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'

class ShopOrderItemBody {
  @IsString() productId!: string
  @IsInt() @Min(1) quantity!: number
}

class ShippingAddressBody {
  @IsString() @MaxLength(200) line1!: string
  @IsOptional() @IsString() @MaxLength(200) line2?: string
  @IsString() @MaxLength(120) city!: string
  @IsOptional() @IsString() @MaxLength(120) region?: string
  @IsString() @MaxLength(20) postalCode!: string
  @IsString() @MaxLength(80) country!: string
}

class CreateShopOrderBody {
  @IsString() siteSlug!: string
  @IsString() @MaxLength(200) name!: string
  @IsEmail() email!: string
  @IsOptional() @IsString() @MaxLength(50) phone?: string
  @IsOptional() @IsString() @MaxLength(2000) notes?: string
  @IsIn(['pickup', 'shipping']) fulfillment!: FulfillmentType
  @IsOptional() @ValidateNested() @Type(() => ShippingAddressBody) shippingAddress?: ShippingAddress
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ShopOrderItemBody)
  items!: ShopOrderItemBody[]
}

@ApiTags('shop')
@Controller('v1/shop')
export class ShopController {
  constructor(private readonly shop: ShopService) {}

  /** GET /v1/shop/products?siteSlug=... */
  @Get('products')
  listProducts(@Query('siteSlug') siteSlug: string) {
    return this.shop.listPublicProducts(siteSlug)
  }

  @Post('orders')
  createOrder(@Body() body: CreateShopOrderBody) {
    return this.shop.createOrder(body)
  }

  /** Create a pending order + Stripe Checkout session (destination charge to the site owner). */
  @Post('checkout')
  checkout(@Body() body: CreateShopOrderBody, @Req() req: Request) {
    const origin = (req.headers.origin as string | undefined) || (req.headers.referer as string | undefined)
    return this.shop.createCheckoutSession(body, origin)
  }

  /** Confirm payment on the storefront success redirect (verifies with Stripe). */
  @Post('orders/:id/confirm')
  confirm(@Param('id') id: string) {
    return this.shop.confirmCheckout(id)
  }

  @Get('orders/:id')
  getOrder(@Param('id') id: string) {
    return this.shop.getPublicOrder(id)
  }
}

class ProductBody {
  @IsString() @MaxLength(80) sku!: string
  @IsString() @MaxLength(200) name!: string
  @IsOptional() @IsString() @MaxLength(4000) description?: string
  @IsInt() @Min(0) priceCents!: number
  @IsOptional() @IsString() @MaxLength(10) currency?: string
  @IsOptional() @IsString() @MaxLength(1000) imageUrl?: string
  @IsOptional() @IsInt() @Min(-1) inventory?: number
  @IsOptional() @IsBoolean() active?: boolean
  @IsOptional() @IsInt() sortOrder?: number
}

class ProductPatchBody {
  @IsOptional() @IsString() @MaxLength(80) sku?: string
  @IsOptional() @IsString() @MaxLength(200) name?: string
  @IsOptional() @IsString() @MaxLength(4000) description?: string
  @IsOptional() @IsInt() @Min(0) priceCents?: number
  @IsOptional() @IsString() @MaxLength(10) currency?: string
  @IsOptional() @IsString() @MaxLength(1000) imageUrl?: string
  @IsOptional() @IsInt() @Min(-1) inventory?: number
  @IsOptional() @IsBoolean() active?: boolean
  @IsOptional() @IsInt() sortOrder?: number
}

class UpdateShopConfigBody {
  @IsOptional() @IsObject() config?: ShopConfig | null
}

class UpdateOrderStatusBody {
  @IsIn(['pending', 'paid', 'fulfilled', 'cancelled']) status!: 'pending' | 'paid' | 'fulfilled' | 'cancelled'
}

@ApiTags('admin:shop')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites/:siteId')
export class AdminShopController {
  constructor(private readonly shop: ShopService) {}

  @Get('products')
  listProducts(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.shop.listForSite(siteId, req.owner)
  }

  @Post('products')
  createProduct(@Param('siteId') siteId: string, @Body() body: ProductBody, @Req() req: AuthRequest) {
    return this.shop.createProduct(siteId, req.owner, body)
  }

  @Patch('products/:productId')
  updateProduct(
    @Param('siteId') siteId: string,
    @Param('productId') productId: string,
    @Body() body: ProductPatchBody,
    @Req() req: AuthRequest,
  ) {
    return this.shop.updateProduct(siteId, req.owner, productId, body)
  }

  @Delete('products/:productId')
  deleteProduct(@Param('siteId') siteId: string, @Param('productId') productId: string, @Req() req: AuthRequest) {
    return this.shop.deleteProduct(siteId, req.owner, productId)
  }

  @Get('shop-orders')
  listOrders(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.shop.listOrders(siteId, req.owner)
  }

  @Patch('shop-orders/:orderId')
  updateOrder(
    @Param('siteId') siteId: string,
    @Param('orderId') orderId: string,
    @Body() body: UpdateOrderStatusBody,
    @Req() req: AuthRequest,
  ) {
    return this.shop.updateOrderStatus(siteId, req.owner, orderId, body.status)
  }

  @Get('shop-config')
  getConfig(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.shop.getShopConfig(siteId, req.owner)
  }

  @Put('shop-config')
  updateConfig(@Param('siteId') siteId: string, @Body() body: UpdateShopConfigBody, @Req() req: AuthRequest) {
    return this.shop.updateShopConfig(siteId, req.owner, body.config ?? null)
  }
}
