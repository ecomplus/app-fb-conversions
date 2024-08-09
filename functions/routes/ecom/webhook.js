const { logger } = require('firebase-functions')
const fbBizSdk = require('facebook-nodejs-business-sdk')
const {
  createContent,
  createCustonData,
  createServeEvent,
  createUserData
} = require('../../lib/fb-api/create-objects')

// read configured E-Com Plus app data
const getAppData = require('./../../lib/store-api/get-app-data')

const SKIP_TRIGGER_NAME = 'SkipTrigger'
const ECHO_SUCCESS = 'SUCCESS'
const ECHO_SKIP = 'SKIP'
const ECHO_API_ERROR = 'STORE_API_ERR'

exports.post = async ({ appSdk }, req, res) => {
  // receiving notification from Store API
  const { storeId } = req

  /**
   * Treat E-Com Plus trigger body here
   * Ref.: https://developers.e-com.plus/docs/api/#/store/triggers/
   */
  const trigger = req.body

  try {
    const appData = await getAppData({ appSdk, storeId })

    if (appData) {
      // get app configured options

      if (
        Array.isArray(appData.ignore_triggers) &&
        appData.ignore_triggers.indexOf(trigger.resource) > -1
      ) {
        // ignore current trigger
        const err = new Error()
        err.name = SKIP_TRIGGER_NAME
        throw err
      }

      let fbPixelId = appData.fb_pixel_id
      let fbGraphToken = appData.fb_graph_token

      if (fbPixelId && fbGraphToken) {
        const EventRequest = fbBizSdk.EventRequest
        fbBizSdk.FacebookAdsApi.init(fbGraphToken)

        if (trigger.resource === 'orders' && trigger.action === 'create') {
          const orderId = trigger.inserted_id
          let order = trigger.body
          if (order.status === 'cancelled') {
            res.sendStatus(204)
            return
          }
          const { domain } = order
          if (domain) {
            const domainSpecificPixel = appData.pixels_by_domain?.find((pixelByDomain) => {
              return pixelByDomain.domain === domain
            })
            if (domainSpecificPixel?.fb_pixel_id && domainSpecificPixel.fb_graph_token) {
              fbPixelId = domainSpecificPixel.fb_pixel_id
              fbGraphToken = domainSpecificPixel.fb_graph_token
            }
          }

          const buyer = order.buyers && order.buyers[0]
          const clientIp = order.browser_ip
          if (orderId && buyer && clientIp) {
            /* DO YOUR CUSTOM STUFF HERE */

            let clientUserAgent, eventID
            const tryFetchOrder = async (isRetry = false) => {
              try {
                const { response } = await appSdk.apiRequest(storeId, `orders/${orderId}.json`)
                order = response.data
                if (order.metafields && order.status !== 'cancelled') {
                  const metafield = order.metafields.find(({ namespace, field }) => {
                    return namespace === 'fb' && field === 'pixel'
                  })
                  if (metafield) {
                    const value = JSON.parse(metafield.value)
                    eventID = value.eventID
                    clientUserAgent = value.userAgent
                  } else if (order.client_user_agent) {
                    clientUserAgent = order.client_user_agent
                  } else if (!isRetry) {
                    await new Promise((resolve) => {
                      setTimeout(() => {
                        logger.log('Retry fetch order')
                        tryFetchOrder(true).then(resolve)
                      }, 20000)
                    })
                  }
                }
              } catch (err) {
                logger.error(err)
              }
              return true
            }
            await tryFetchOrder()
            if (order.status === 'cancelled') {
              res.sendStatus(204)
              return
            }

            // https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api#send
            const userData = createUserData(buyer, clientIp)

            if (clientUserAgent) {
              userData.setClientUserAgent(clientUserAgent)
            }
            const shippingLine = order.shipping_lines && order.shipping_lines[0]
            if (shippingLine && shippingLine.to.zip) {
              userData.setZip(shippingLine.to.zip.replace(/\D/g, ''))
              if (shippingLine.to.province_code) {
                userData.setState(shippingLine.to.province_code.toLowerCase())
                userData.setCountry((shippingLine.to.country_code || 'BR').toLowerCase())
              }
            }

            const contents = []
            const { items } = order
            if (items && items.length) {
              items.forEach(item => {
                if (item.quantity > 0) {
                  const content = createContent(item)
                  contents.push(content)
                }
              })
            }
            const customData = createCustonData(contents, order.amount.total, order.currency_id)

            const eventMs = Math.min(new Date(order.created_at || trigger.datetime).getTime(), Date.now() - 3000)
            console.log(`#${storeId} order ${orderId} (${eventID}) at ${eventMs}ms`)

            let eventSourceUrl
            if (order.checkout_link) {
              eventSourceUrl = order.checkout_link
            } else if (domain) {
              eventSourceUrl = `https://${domain}`
            }
            const serverEvent = createServeEvent(
              'Purchase',
              eventMs,
              userData,
              customData,
              eventID || orderId,
              eventSourceUrl
            )

            const eventsData = [serverEvent]
            const eventRequest = (new EventRequest(fbGraphToken, fbPixelId))
              .setEvents(eventsData)

            return eventRequest.execute().then(
              response => {
                // console.log('>> ', response)
                logger.info(response)
                // all done
                res.status(201).send(ECHO_SUCCESS)
              },
              err => {
                console.error(`Facebook event request error: ${err.message}`, err, JSON.stringify(trigger))
                res.sendStatus(202)
              }
            )
          }
        } else if (trigger.resource === 'carts' && trigger.action === 'create' && !appData.fb_disable_cart) {
          // https://developers.facebook.com/docs/meta-pixel/reference#standard-events

          // Event name: InitiateCheckout
          // custom_event_type: INITIATE_CHECKOUT
          // Properties
          // content_category, content_ids, contents, currency, num_items and value

          // console.log('>>> ', trigger, ' <<<')

          const cartId = trigger.inserted_id
          const cart = trigger.body

          if (cart.completed) {
            res.sendStatus(204)
            return
          }

          const eventMs = Math.min(new Date(cart.created_at || trigger.datetime).getTime(), Date.now() - 3000)
          console.log(`#${storeId} cart ${cartId} at ${eventMs}ms`)

          const tryFetchCustomer = async (customerId) => {
            const { response } = await appSdk.apiRequest(storeId, `customers/${customerId}.json`)
            return response.data
          }

          let customer
          if (cart.customers && cart.customers.length > 0) {
            customer = await tryFetchCustomer(cart.customers[0])
          }

          let userData
          let address
          if (customer) {
            userData = createUserData(customer)
            if (customer.addresses && customer.addresses.length > 0) {
              address = customer.addresses[0]
            }
          }

          if (address && address.zip) {
            userData.setZip(address.zip.replace(/\D/g, ''))
            if (address.province_code) {
              userData.setState(address.province_code.toLowerCase())
              userData.setCountry((address.country_code || 'BR').toLowerCase())
            }
          }

          const contents = []
          const { items } = cart
          if (items && items.length) {
            items.forEach(item => {
              if (item.quantity > 0) {
                const content = createContent(item)
                contents.push(content)
              }
            })
          }
          const customData = createCustonData(contents, cart.subtotal)

          let eventSourceUrl
          if (cart.permalink) {
            eventSourceUrl = cart.permalink
          }
          const serverEvent = createServeEvent(
            'InitiateCheckout',
            eventMs,
            userData,
            customData,
            cartId,
            eventSourceUrl
          )

          const eventsData = [serverEvent]
          const eventRequest = (new EventRequest(fbGraphToken, fbPixelId))
            .setEvents(eventsData)

          return eventRequest.execute().then(
            response => {
              // console.log('>> ', response)
              logger.info(response)
              // all done
              res.status(201).send(ECHO_SUCCESS)
            },
            err => {
              console.error(`Facebook event request error: ${err.message}`, err, JSON.stringify(trigger))
              res.sendStatus(202)
            }
          )
        }
      }
      res.sendStatus(412)
    } else {
      res.sendStatus(401)
    }
  } catch (err) {
    if (err.name === SKIP_TRIGGER_NAME) {
      // trigger ignored by app configuration
      res.send(ECHO_SKIP)
    } else if (err.appWithoutAuth === true) {
      const msg = `Webhook for ${storeId} unhandled with no authentication found`
      const error = new Error(msg)
      error.trigger = JSON.stringify(trigger)
      console.error(error)
      res.status(412).send(msg)
    } else {
      console.error(err)
      // request to Store API with error response
      // return error status code
      res.status(500)
      const { message } = err
      res.send({
        error: ECHO_API_ERROR,
        message
      })
    }
  }
}
